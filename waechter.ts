import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { imapFlow } from './imap.ts';

// Postfach-Wächter per IMAP-IDLE (A-1442, Baustein 7, hier als Plugin-Dauerprozess): zählt neue Mails in INBOX und im
// Gesendet-Ordner direkt am Mailserver. Nur lesend, nur Zahlen. Nie Betreff, Adresse oder Inhalt, nie das Passwort im Log.
//
// Gezählt wird über UIDNEXT je Ordner: was seit dem letzten Stand dazukam. IDLE auf INBOX meldet Eingänge
// sofort, der Gesendet-Ordner wird per STATUS nachgesehen (bei jedem Ereignis und im Takt). Nach einem
// Abbruch verbindet der Wächter selbst neu, mit Backoff, und gleicht über UIDNEXT ab: was in der Lücke kam, zählt
// genau einmal. Ändert sich UIDVALIDITY, gilt der neue Stand als Basis, ohne zu zählen.

/** Was der Wächter vom IMAP-Client braucht. Im Test eine Attrappe. */
export interface ImapClient {
  usable: boolean;
  connect(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  mailboxOpen(path: string): Promise<unknown>;
  status(path: string, q: { uidNext: true; uidValidity: true }): Promise<{ uidNext?: number; uidValidity?: bigint | number }>;
  on(ereignis: 'exists' | 'close' | 'error', f: (...a: unknown[]) => void): void;
  logout(): Promise<void>;
}

export interface WaechterOrt {
  /** Async, damit der Aufrufer den Client je Verbindung neu baut. Wirft, wenn kein Zugang da ist. */
  neuerClient: () => ImapClient | Promise<ImapClient>;
  /** Neue Mails seit dem letzten Stand, nur Zahlen. */
  melde: (neu: { anzahl: number; gesendet: number }) => void;
  /** Zustand für das Log, nur Wörter und Zahlen. */
  zustand?: (z: { art: 'verbunden' | 'getrennt' | 'warte' | 'basis' | 'fehler'; text: string }) => void;
  /** Gesendet-Ordner nachsehen, Standard 60 s. */
  sentMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Datei für den UIDNEXT-Stand je Ordner (nur Ordner, UIDNEXT, UIDVALIDITY), damit ein Neustart die Lücke zählt. */
  standDatei?: string;
  /** Für Tests: Warten. */
  schlafe?: (ms: number) => Promise<void>;
}

type Stand = { uidNext: number; uidValidity: string };

export class Waechter {
  private client: ImapClient | null = null;
  private stand = new Map<string, Stand>();
  private sentPfad: string | null = null;
  private aktiv = false;
  private versuch = 0;
  private takt: ReturnType<typeof setInterval> | null = null;
  private pruefend = false;
  // Gezählt, aber noch nicht gemeldet (melde warf).
  private offen = { anzahl: 0, gesendet: 0 };
  verbindungen = 0;

  constructor(private ort: WaechterOrt) {
    this.ladeStand();
  }

  private ladeStand(): void {
    if (!this.ort.standDatei) return;
    try {
      const j = JSON.parse(readFileSync(this.ort.standDatei, 'utf8')) as Record<string, { uidNext?: unknown; uidValidity?: unknown }>;
      for (const [pfad, v] of Object.entries(j)) if (typeof v?.uidNext === 'number' && typeof v.uidValidity === 'string') this.stand.set(pfad, { uidNext: v.uidNext, uidValidity: v.uidValidity });
    } catch {
      // Keine oder kaputte Datei: der erste Abgleich setzt eine Basis ohne Zählung
    }
  }

  private speichereStand(): void {
    if (!this.ort.standDatei) return;
    try {
      mkdirSync(dirname(this.ort.standDatei), { recursive: true });
      writeFileSync(`${this.ort.standDatei}.neu`, JSON.stringify(Object.fromEntries(this.stand)));
      renameSync(`${this.ort.standDatei}.neu`, this.ort.standDatei);
    } catch {
      // Der Stand ist eine Hilfe gegen Lücken, kein Muss
    }
  }

  private z(art: 'verbunden' | 'getrennt' | 'warte' | 'basis' | 'fehler', text: string): void {
    this.ort.zustand?.({ art, text });
  }

  start(): void {
    if (this.aktiv) return;
    this.aktiv = true;
    void this.schleife();
  }

  async stop(): Promise<void> {
    this.aktiv = false;
    if (this.takt) clearInterval(this.takt);
    this.takt = null;
    const c = this.client;
    this.client = null;
    if (c?.usable) await c.logout().catch(() => {});
  }

  /** Verbinden, Basis bzw. Abgleich, IDLE auf INBOX. Endet erst, wenn stop() lief. */
  private async schleife(): Promise<void> {
    const schlafe = this.ort.schlafe ?? ((ms: number) => Bun.sleep(ms));
    while (this.aktiv) {
      const ende = await this.einLauf();
      if (!this.aktiv) break;
      this.versuch++;
      const min = this.ort.backoffMinMs ?? 1000;
      const max = this.ort.backoffMaxMs ?? 300000;
      const warte = Math.min(max, min * 2 ** Math.min(this.versuch - 1, 20));
      this.z('warte', `${ende}, neuer Versuch in ${Math.round(warte / 1000)} s`);
      await schlafe(warte);
    }
  }

  /** Ein Verbindungsleben. Liefert den Grund des Endes. */
  private async einLauf(): Promise<string> {
    let c: ImapClient;
    try {
      c = await this.ort.neuerClient();
    } catch (e) {
      // Die Meldung nennt nie das Passwort.
      return e instanceof Error ? e.message : 'Zugang nicht lesbar';
    }
    this.client = c;
    const t = Date.now();
    let geschlossen: (grund: string) => void = () => {};
    const zu = new Promise<string>((r) => (geschlossen = r));
    c.on('close', () => geschlossen('Verbindung geschlossen'));
    c.on('error', (e) => geschlossen(`Fehler ${e instanceof Error ? e.name : 'unbekannt'}`));
    try {
      await c.connect();
      this.verbindungen++;
      this.versuch = 0;
      const ordner = await c.list();
      this.sentPfad = ordner.find((o) => o.specialUse === '\\Sent')?.path ?? null;
      await this.abgleich(c);
      // Ohne gehaltene Sperre öffnen: imapflow startet IDLE nur, wenn keine Sperre gehalten wird.
      await c.mailboxOpen('INBOX');
      c.on('exists', () => void this.abgleich(c));
      this.z('verbunden', `verbunden in ${Date.now() - t} ms${this.sentPfad ? '' : ', kein Gesendet-Ordner'}`);
      if (this.takt) clearInterval(this.takt);
      this.takt = setInterval(() => void this.abgleich(c), this.ort.sentMs ?? 60000);
      const grund = await zu;
      if (this.takt) clearInterval(this.takt);
      this.takt = null;
      this.z('getrennt', grund);
      return grund;
    } catch (e) {
      const grund = `Fehler ${e instanceof Error ? e.name : 'unbekannt'}`;
      this.z('fehler', grund);
      if (c.usable) await c.logout().catch(() => {});
      return grund;
    }
  }

  /**
   * UIDNEXT je Ordner gegen den letzten Stand. Nur hier wird gezählt. Jeder Ordner für sich: scheitert einer,
   * zählt der andere trotzdem. Der Stand geht erst nach erfolgreichem Melden auf die Platte, ein Neustart
   * zählt im Zweifel doppelt statt zu verlieren.
   */
  private async abgleich(c: ImapClient): Promise<void> {
    if (this.pruefend || !c.usable) return;
    this.pruefend = true;
    try {
      for (const [pfad, art] of [['INBOX', 'anzahl'], ...(this.sentPfad ? [[this.sentPfad, 'gesendet']] : [])] as [string, 'anzahl' | 'gesendet'][]) {
        try {
          const s = await c.status(pfad, { uidNext: true, uidValidity: true });
          if (typeof s.uidNext !== 'number') continue;
          const jetzt: Stand = { uidNext: s.uidNext, uidValidity: String(s.uidValidity ?? '') };
          const alt = this.stand.get(pfad);
          this.stand.set(pfad, jetzt);
          if (!alt) {
            this.z('basis', `${art === 'anzahl' ? 'INBOX' : 'Gesendet'}: Basis gesetzt`);
            continue;
          }
          if (alt.uidValidity !== jetzt.uidValidity) {
            this.z('basis', `${art === 'anzahl' ? 'INBOX' : 'Gesendet'}: UIDVALIDITY geändert, neue Basis ohne Zählung`);
            continue;
          }
          if (jetzt.uidNext > alt.uidNext) this.offen[art] += jetzt.uidNext - alt.uidNext;
        } catch {
          // Ein gescheiterter STATUS dieses Ordners betrifft nur ihn, der nächste Abgleich holt es nach.
        }
      }
      if (this.offen.anzahl + this.offen.gesendet > 0) {
        const zuMelden = { ...this.offen };
        // Wirft melde, bleibt offen stehen und geht beim nächsten Abgleich mit raus.
        this.ort.melde(zuMelden);
        this.offen = { anzahl: this.offen.anzahl - zuMelden.anzahl, gesendet: this.offen.gesendet - zuMelden.gesendet };
      }
      this.speichereStand();
    } catch {
      // Ein Wurf beim Melden beendet die Verbindung nicht, der nächste Abgleich versucht es erneut.
    } finally {
      this.pruefend = false;
    }
  }
}

/** Echter Client über denselben Weg wie die Werkzeuge (imapFlow ohne Logger, nichts aus dem Protokoll im Log). */
export function imapClient(o: { host: string; port?: number; user: string; pass: string }): ImapClient {
  return imapFlow({ host: o.host, port: o.port ?? 993, user: o.user, pass: o.pass }) as unknown as ImapClient;
}
