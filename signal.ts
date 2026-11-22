import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Mail-Signal im Plugin (A-2346, vorher im Kern: server/mailsignal.ts). Das Plugin zählt (Wächter), puffert
// (mailsignal-puffer.json), hält den Nachhol-Stand (mailsignal-nachhol.json) und bildet den Text selbst. Der Kern stellt ihn
// als Ereignis mail.neu mit Rahmen roh unverändert zu (ADR 0042). Nur Anzahlen, nie Absender, Betreff oder Inhalt.
// Dateinamen und Felder bleiben gleich, damit der Umzug sie 1:1 kopiert (ADR 0047).

export const PUFFER_DATEI = 'mailsignal-puffer.json';
export const NACHHOL_DATEI = 'mailsignal-nachhol.json';

/** Zahlen eines Ereignisses. unbekannt: neue Mail gemeldet, aber ohne gültige Zahlen. */
export interface SignalZahlen {
  anzahl: number;
  gesendet: number;
  unbekannt?: boolean;
}

/** Nachhol-Signal: nur die Anzahl liegengebliebener Mails (älter als 24 h). */
export function nachholText(n: number): string {
  return `<channel source="mailsignal" anzahl="${n}" alt="1">${n === 1 ? '1 liegengebliebene Mail' : `${n} liegengebliebene Mails`} (älter als 24 h)</channel>`;
}

/** Text im Format des früheren Channels. gesendet steht nur drin, wenn etwas gesendet wurde. Bei reinem "unbekannt" nennt der Text keine Zahl. */
export function signalText(e: SignalZahlen, gesammelt: boolean): string {
  const attr: string[] = [];
  let content: string;
  const nurUnbekannt = e.unbekannt === true && e.anzahl === 0 && e.gesendet === 0;
  if (nurUnbekannt) {
    content = 'neue Mail, Anzahl unbekannt';
  } else {
    const eingang = e.anzahl === 1 ? '1 neue Mail' : `${e.anzahl} neue Mails`;
    attr.push(` anzahl="${e.anzahl}"`);
    content = eingang;
    if (e.gesendet > 0) {
      attr.push(` gesendet="${e.gesendet}"`);
      content = e.anzahl === 0 ? (e.gesendet === 1 ? '1 Mail gesendet' : `${e.gesendet} Mails gesendet`) : `${eingang}, ${e.gesendet} gesendet`;
    }
    if (e.unbekannt) content += ', dazu neue Mails ohne Zahl';
  }
  if (e.unbekannt) attr.push(' unbekannt="1"');
  if (gesammelt) {
    attr.push(' gesammelt="1"');
    content += ' (gesammelt bei zugeklapptem Laptop)';
  }
  return `<channel source="mailsignal"${attr.join('')}>${content}</channel>`;
}

export interface MailSignalOrt {
  /** Nachhol-Hinweis: letzte gemeldete Anzahl und Zeitpunkt, damit ein Neustart nicht erneut meldet, dazu der Name des Empfängers. */
  nachholStand?: string;
  /** Puffer ungemeldeter Mails (JSON, nur Zahlen), damit ein Neustart bei zugeklapptem Laptop nichts verliert. */
  pufferDatei?: string;
  /** Aus dem Takt-Kontext (klappe.zu), nicht mehr per ioreg im Kern gemessen. */
  zugeklappt: () => boolean;
  /** Name des Empfängers. Steht im Nachhol-Stand, damit ein Wechsel den Hinweis neu meldet. Das Plugin kennt die Einstellung des Kerns nicht, ohne Angabe gilt chef. */
  empfaenger?: () => string;
  /** Zustellen als Ereignis. true: angenommen. false: abgelehnt, es bleibt hier gepuffert. */
  zustellen: (text: string) => boolean;
}

const zahl = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

function schreibeAtomar(pfad: string, inhalt: unknown): void {
  mkdirSync(dirname(pfad), { recursive: true });
  writeFileSync(`${pfad}.neu`, JSON.stringify(inhalt));
  renameSync(`${pfad}.neu`, pfad);
}

export class MailSignal {
  private nachholSpeicher: { n: number; am: number; an: string } | null = null;
  private puffer = { anzahl: 0, gesendet: 0, unbekannt: false, gesammelt: false };
  /** letzterLauf: Zeit der letzten Meldung des Wächters. */
  stand: { letzterLauf: number | null; zugestellt: number } = { letzterLauf: null, zugestellt: 0 };

  constructor(private ort: MailSignalOrt) {
    this.ladePuffer();
  }

  private ladePuffer(): void {
    if (!this.ort.pufferDatei) return;
    try {
      const j = JSON.parse(readFileSync(this.ort.pufferDatei, 'utf8')) as { anzahl?: unknown; gesendet?: unknown; unbekannt?: unknown; gesammelt?: unknown };
      const unbekannt = j.unbekannt === true;
      // Nach einem Neustart gilt Gepuffertes als gesammelt: es kommt nachträglich, nicht als frische Unterbrechung.
      this.puffer = { anzahl: zahl(j.anzahl), gesendet: zahl(j.gesendet), unbekannt, gesammelt: j.gesammelt === true || zahl(j.anzahl) + zahl(j.gesendet) > 0 || unbekannt };
    } catch {
      // Keine oder kaputte Datei: leerer Puffer
    }
  }

  private schreibePuffer(): void {
    if (!this.ort.pufferDatei) return;
    try {
      schreibeAtomar(this.ort.pufferDatei, this.puffer);
    } catch {
      // Ohne Datei bleibt der Puffer im Speicher
    }
  }

  /**
   * Neue Mails vom Wächter: puffern und zustellen. Ohne neue Zahlen liefert es nur Gepuffertes nach (etwa nach dem
   * Aufklappen). Der Puffer geht vor dem Zustellen auf die Platte, ein Neustart verliert nichts.
   */
  melde(neu: SignalZahlen = { anzahl: 0, gesendet: 0 }, jetzt = Date.now()): void {
    const hatNeues = neu.anzahl + neu.gesendet > 0 || neu.unbekannt === true;
    this.puffer.anzahl += neu.anzahl;
    this.puffer.gesendet += neu.gesendet;
    if (neu.unbekannt) this.puffer.unbekannt = true;
    if (this.puffer.anzahl + this.puffer.gesendet === 0 && !this.puffer.unbekannt) return;
    if (hatNeues) {
      this.stand.letzterLauf = jetzt;
      this.schreibePuffer();
    }
    if (this.ort.zugeklappt()) {
      this.puffer.gesammelt = true;
      this.schreibePuffer();
      return;
    }
    if (this.ort.zustellen(signalText(this.puffer, this.puffer.gesammelt))) {
      this.stand.zugestellt++;
      this.puffer = { anzahl: 0, gesendet: 0, unbekannt: false, gesammelt: false };
      this.schreibePuffer();
    }
  }

  /**
   * Liegengebliebene Mails (älter als 24 h, ohne Triage oder unklar) melden: nur wenn n > 0 und sich n seit dem
   * letzten Hinweis geändert hat oder ein Tag vergangen ist. Bei zugeklapptem Laptop bleibt der Stand unberührt, der
   * nächste Lauf versucht es wieder. Ein anderer Empfänger gilt als nicht gemeldet. Ein Stand ohne Namen ist von chef.
   */
  meldeAlt(n: number, jetzt = Date.now()): boolean {
    if (n <= 0 || this.ort.zugeklappt()) return false;
    const an = this.ort.empfaenger?.() ?? 'chef';
    const alt = this.leseNachholStand();
    if (alt && alt.an === an && alt.n === n && jetzt - alt.am < 24 * 60 * 60 * 1000) return false;
    if (!this.ort.zustellen(nachholText(n))) return false;
    this.stand.zugestellt++;
    this.nachholSpeicher = { n, am: jetzt, an };
    if (this.ort.nachholStand) {
      try {
        schreibeAtomar(this.ort.nachholStand, { n, am: jetzt, an });
      } catch {
        // Ohne Stand meldet der nächste Lauf höchstens einmal zu viel
      }
    }
    return true;
  }

  private leseNachholStand(): { n: number; am: number; an: string } | null {
    if (!this.ort.nachholStand) return this.nachholSpeicher;
    try {
      const j = JSON.parse(readFileSync(this.ort.nachholStand, 'utf8')) as { n?: unknown; am?: unknown; an?: unknown };
      return typeof j.n === 'number' && typeof j.am === 'number' ? { n: j.n, am: j.am, an: typeof j.an === 'string' ? j.an : 'chef' } : null;
    } catch {
      return null;
    }
  }

  gepuffert(): { anzahl: number; gesendet: number; unbekannt: boolean } {
    return { anzahl: this.puffer.anzahl, gesendet: this.puffer.gesendet, unbekannt: this.puffer.unbekannt };
  }
}
