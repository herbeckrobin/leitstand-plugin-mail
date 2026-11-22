import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MailSignal } from './signal.ts';
import { WerkzeugFehler, type Werkzeug } from './typen.ts';

// Takt des Mail-Plugins (A-2346, Vertrag A-2282 mit dem Kern): der Kern ruft das Werkzeug takt alle paar Sekunden mit dem
// Kontext, den die plugin.yml nennt, und führt die Aktionen aus, die zurückkommen. Hier liegen die Mail-Triage (vorher
// server/mailtriage.ts), der Entwurf-Prüfer (server/entwurf-pruefer.ts) und das Nachholen (stündlich, ohne Aktion).
// Das Modell bestellt das Plugin als Aktion modell, das Ergebnis kommt im NÄCHSTEN Takt in kontext.modell.
// DSGVO: ins Log, in Störungstexte und in Beleg-Felder gehören nur Wörter und Zahlen, nie Absender, Betreff oder Text.
// Die Sammlung der offenen Karte (Absender, Betreff) liegt lokal in mailtriage-stand.json wie bisher im Kern.

type Json = Record<string, unknown>;

export const TRIAGE_STAND_DATEI = 'mailtriage-stand.json';
/** Titel-Präfix: daran erkennt das Plugin seine offene Sammelkarte in kontext.karten. */
export const TRIAGE_TITEL = 'Mail-Triage:';
export const MAX_AKTIONEN = 20;
const MAX_MODELL_JE_TAKT = 3;
const MAIL_JE_ANFRAGE = 20;
const MODELL_WARTE_MS = 5 * 60 * 1000;
const NACHHOL_TAKT_MS = 60 * 60 * 1000;
const ENTWURF_PAUSE_MS = 60 * 1000;

// ------------------------------------------------------------------ Aktionen ----

export type Aktion =
  | { art: 'karte_neu'; schluessel: string; typ: 'info' | 'review' | 'entscheidung'; titel: string; kontext: string[]; details: string }
  | { art: 'karte_erledige'; id: string; beleg: string }
  | { art: 'stoerung'; stelle: string; text: string }
  | { art: 'vermerk'; schluessel: string; wert: unknown }
  | { art: 'modell'; id: string; prompt: string; max_zeichen: number };

const kuerze = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

// ------------------------------------------------------------------ Eingabe ----

export interface TaktKarte {
  id: string;
  typ: string;
  titel: string;
  /** Entwurf-Verweis einer Review-Karte. Der Vertrag nennt das Feld noch nicht (offen, A-2346), fehlt es, prüft das Plugin keine Entwürfe. */
  entwurf: { konto: string; uuid: string | null; uid: number | null; art: 'antwort' | 'neu' } | null;
}
export interface TaktAufgabe {
  aId: string;
  titel: string;
  ball: string | null;
  kunde: string | null;
  projekt: string | null;
  faellig: string | null;
  offen: boolean;
}
export type ModellErgebnis = { id: string; ergebnis: string } | { id: string; fehler: string };
export interface TaktEingabe {
  jetzt: number;
  klappeZu: boolean;
  karten: TaktKarte[];
  aufgaben: TaktAufgabe[];
  modell: ModellErgebnis[];
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const objekt = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);

/** Liest den Takt-Kontext. Außer jetzt ist alles optional (nur was in kontext steht, kommt an). Wirft WerkzeugFehler bei kaputtem jetzt. */
export function leseEingabe(a: Json): TaktEingabe {
  const jetzt = typeof a.jetzt === 'string' ? Date.parse(a.jetzt) : NaN;
  if (Number.isNaN(jetzt)) throw new WerkzeugFehler('jetzt fehlt oder ist kein Zeitpunkt');
  const liste = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const karten: TaktKarte[] = [];
  for (const k of liste(a.karten)) {
    const o = objekt(k);
    if (!o || typeof o.id !== 'string') continue;
    const e = objekt(o.entwurf);
    const art = e?.art === 'neu' ? 'neu' : 'antwort';
    karten.push({
      id: o.id,
      typ: text(o.typ) ?? '',
      titel: text(o.titel) ?? '',
      entwurf: e && typeof e.konto === 'string' ? { konto: e.konto, uuid: text(e.uuid) || null, uid: typeof e.uid === 'number' ? e.uid : null, art } : null,
    });
  }
  const aufgaben: TaktAufgabe[] = [];
  for (const k of liste(a.aufgaben)) {
    const o = objekt(k);
    if (!o) continue;
    aufgaben.push({
      aId: text(o.a_id) ?? '',
      titel: text(o.titel) ?? '',
      ball: text(o.ball),
      kunde: text(o.kunde),
      projekt: text(o.projekt),
      faellig: text(o.faellig),
      offen: o.offen !== false,
    });
  }
  const modell: ModellErgebnis[] = [];
  for (const k of liste(a.modell)) {
    const o = objekt(k);
    if (!o || typeof o.id !== 'string') continue;
    if (typeof o.ergebnis === 'string') modell.push({ id: o.id, ergebnis: o.ergebnis });
    else modell.push({ id: o.id, fehler: text(o.fehler) ?? 'fehler' });
  }
  return { jetzt, klappeZu: objekt(a.klappe)?.zu === true, karten, aufgaben, modell };
}

// ------------------------------------------------------------------- Mails ----

export interface Mail {
  konto: string;
  uid: number;
  von: string;
  adresse: string;
  betreff: string;
}
export type Urteil = 'braucht' | 'warten';
export type Grund = 'regel' | 'modell' | 'rueckfall';
export interface Einordnung {
  mail: Mail;
  urteil: Urteil;
  grund: Grund;
}

export const anzeigeName = (m: Pick<Mail, 'von' | 'adresse'>): string => m.von || m.adresse || '(ohne Absender)';
export const mailSchluessel = (m: Pick<Mail, 'konto' | 'uid'>): string => `${m.konto}|${m.uid}`;

/** Mail aus der Antwort von neue_seit. null ohne lesbaren Absender und Betreff. */
export function leseMail(konto: string, n: unknown): Mail | null {
  const o = objekt(n);
  if (!o || typeof o.uid !== 'number') return null;
  const von = objekt(Array.isArray(o.von) ? o.von[0] : null);
  const mail: Mail = { konto, uid: o.uid, von: (text(von?.name) ?? '').trim(), adresse: (text(von?.adresse) ?? '').trim(), betreff: (text(o.betreff) ?? '').trim() };
  return mail.adresse || mail.betreff ? mail : null;
}

// ----------------------------------------------------------- Regel und Modell ----

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
const kommtVor = (heu: string, name: string): boolean => {
  const n = norm(name.trim());
  const i = heu.indexOf(n);
  if (i < 0) return false;
  const vor = heu[i - 1];
  const nach = heu[i + n.length];
  return !(vor && /[\p{L}\p{N}]/u.test(vor)) && !(nach && /[\p{L}\p{N}]/u.test(nach));
};

/** JJJJ-MM-TT des Tages nach jetzt in Berlin. */
export const morgenIso = (jetzt: number): string => new Date(jetzt + 24 * 3600_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/**
 * Regel aus dem Index: gehört der Absender zu einem Kunden oder Projekt (Name in Absender, Adresse oder Betreff) mit
 * offenem Ball bei Robin oder einer offenen Aufgabe mit Frist bis morgen, braucht die Mail ihn. Ohne kunde und projekt in
 * den Aufgaben (der Vertrag nennt sie noch nicht) greift nie eine Regel, dann urteilt das Modell.
 */
export function regelUrteil(m: Mail, aufgaben: TaktAufgabe[], jetzt: number): 'braucht' | null {
  const heu = norm(`${m.von} ${m.adresse} ${m.betreff}\n`);
  let bester: { kunde: string | null; projekt: string | null; rang: number } | null = null;
  const gesehen = new Set<string>();
  for (const a of aufgaben) {
    const k = `${a.kunde}|${a.projekt}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    for (const [name, projekt] of [[a.projekt, true], [a.kunde, false]] as const) {
      if (!name || name.trim().length < 3 || !kommtVor(heu, name)) continue;
      const rang = (projekt ? 1000 : 0) + name.length;
      if (!bester || rang > bester.rang) bester = { kunde: a.kunde, projekt: projekt ? a.projekt : null, rang };
    }
  }
  if (!bester) return null;
  const t = bester;
  const imTreffer = (a: TaktAufgabe): boolean => a.kunde === t.kunde && (t.projekt === null || a.projekt === t.projekt);
  if (aufgaben.some((a) => a.offen && a.ball !== null && /(^|[^\p{L}])robin([^\p{L}]|$)/iu.test(a.ball) && imTreffer(a))) return 'braucht';
  const morgen = morgenIso(jetzt);
  return aufgaben.some((a) => a.offen && a.faellig !== null && a.faellig <= morgen && imTreffer(a)) ? 'braucht' : null;
}

export const TRIAGE_SYSTEM = [
  'Du sortierst eingehende Mails eines Freelance-Webentwicklers. Du siehst nur Absender und Betreff.',
  'Antworte mit braucht=true, wenn die Mail wahrscheinlich eine Antwort, Entscheidung oder Handlung von ihm verlangt:',
  'Kundenanfrage, Frage, Terminwunsch, Freigabe, Fehlermeldung, Rechnung oder Mahnung an ihn, Frist.',
  'Antworte mit braucht=false bei Newslettern, Werbung, automatischen Benachrichtigungen, Bestätigungen und Quittungen ohne Handlung.',
  'Im Zweifel braucht=true.',
].join(' ');

/** Eine Anfrage für bis zu 20 Mails: nummerierte Zeilen mit Absender und Betreff, Antwort ein JSON-Array. Der Mailtext wird nie gelesen. */
export function modellPrompt(mails: Mail[]): string {
  const zeilen = mails.map((m, i) => `${i + 1}. Absender: ${anzeigeName(m)} <${m.adresse}> | Betreff: ${m.betreff.slice(0, 300).replace(/\s+/g, ' ')}`);
  return [TRIAGE_SYSTEM, 'Beurteile jede Mail einzeln. Antworte nur mit einem JSON-Array, je Mail ein Objekt: [{"n":1,"braucht":true}, ...].', ...zeilen].join('\n');
}

/** Urteile je Nummer (1-basiert). Fehlt eine Nummer oder ist braucht kein boolean, gibt es für sie kein Urteil. */
export function leseUrteile(roh: string): Map<number, Urteil> {
  const aus = new Map<number, Urteil>();
  const m = /\[[\s\S]*\]/.exec(roh);
  if (!m) return aus;
  try {
    const j = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(j)) return aus;
    for (const e of j) {
      const o = objekt(e);
      if (o && typeof o.n === 'number' && Number.isInteger(o.n) && (o.braucht === true || o.braucht === false)) aus.set(o.n, o.braucht ? 'braucht' : 'warten');
    }
  } catch {
    // Kein JSON heißt: kein Urteil, die Mails zählen als "braucht dich"
  }
  return aus;
}

// -------------------------------------------------------------------- Karte ----

const MAX_ZEILEN = 20;
const zeile = (m: Mail): string => `- ${anzeigeName(m)}: ${m.betreff || '(ohne Betreff)'}`.replace(/\s*\n\s*/g, ' ');

function block(titel: string, l: Einordnung[]): string[] {
  if (l.length === 0) return [];
  const aus = [`${titel}:`, ...l.slice(0, MAX_ZEILEN).map((e) => zeile(e.mail))];
  if (l.length > MAX_ZEILEN) aus.push(`- und ${l.length - MAX_ZEILEN} weitere`);
  return aus;
}

/**
 * Die Sammelkarte als Aktion. Der Vertrag erlaubt höchstens 10 Zeilen à 300 im kontext und 4000 Zeichen in details:
 * was darüber liegt, wandert an den Anfang der details, "kann warten" folgt dahinter.
 */
export function triageKarte(schluessel: string, e: Einordnung[], ausgelassen: number): Aktion {
  const braucht = e.filter((x) => x.urteil === 'braucht');
  const warten = e.filter((x) => x.urteil === 'warten');
  const ohne = braucht.filter((x) => x.grund === 'rueckfall').length;
  const alle = block('Brauchen dich', braucht);
  if (ohne > 0) alle.push(`${ohne} davon ohne Einordnung (Modell nicht erreichbar oder zu langsam), sicherheitshalber hier.`);
  if (ausgelassen > 0) alle.push(`${ausgelassen} weitere nicht eingeordnet, im Postfach ansehen.`);
  const kontext = alle.slice(0, 10).map((z) => kuerze(z, 300));
  const details = [...alle.slice(10), ...block('Können warten', warten)].join('\n');
  return { art: 'karte_neu', schluessel, typ: 'info', titel: kuerze(`${TRIAGE_TITEL} ${braucht.length + ausgelassen} brauchen dich, ${warten.length} können warten`, 200), kontext, details: kuerze(details, 4000) };
}

// -------------------------------------------------------------- Stand-Datei ----

export interface PostfachStand {
  uidValidity: string;
  uidNext: number;
}
interface Wartet {
  id: string;
  bestellt: number;
  mails: Mail[];
}
interface Sammlung {
  einordnungen: Einordnung[];
  ausgelassen: number;
  /** Zeit der ersten Mail der Karte: macht den Schlüssel der Karte eindeutig, bis sie erledigt ist. */
  seit: number;
}
interface StandDatei {
  staende: Map<string, PostfachStand>;
  sammlung: Sammlung;
  wartet: Wartet[];
}

const URTEILE = ['braucht', 'warten'];
const GRUENDE = ['regel', 'modell', 'rueckfall'];

function leseMailFeld(v: unknown): Mail | null {
  const m = objekt(v);
  if (!m || typeof m.konto !== 'string' || typeof m.uid !== 'number' || typeof m.von !== 'string' || typeof m.adresse !== 'string' || typeof m.betreff !== 'string') return null;
  return { konto: m.konto, uid: m.uid, von: m.von, adresse: m.adresse, betreff: m.betreff };
}

function leseEinordnung(v: unknown): Einordnung | null {
  const o = objekt(v);
  const mail = leseMailFeld(o?.mail);
  if (!o || !mail || !URTEILE.includes(o.urteil as string) || !GRUENDE.includes(o.grund as string)) return null;
  return { mail, urteil: o.urteil as Urteil, grund: o.grund as Grund };
}

const leerStand = (): StandDatei => ({ staende: new Map(), sammlung: { einordnungen: [], ausgelassen: 0, seit: 0 }, wartet: [] });

function ladeStand(pfad: string): StandDatei {
  const s = leerStand();
  if (!existsSync(pfad)) return s;
  try {
    const j = objekt(JSON.parse(readFileSync(pfad, 'utf8')));
    for (const [k, v] of Object.entries(objekt(j?.staende) ?? {})) {
      const o = objekt(v);
      if (o && typeof o.uidNext === 'number' && typeof o.uidValidity === 'string') s.staende.set(k, { uidNext: o.uidNext, uidValidity: o.uidValidity });
    }
    const sam = objekt(j?.sammlung);
    if (sam && Array.isArray(sam.einordnungen)) {
      s.sammlung = {
        einordnungen: sam.einordnungen.map(leseEinordnung).filter((e): e is Einordnung => e !== null),
        ausgelassen: typeof sam.ausgelassen === 'number' && sam.ausgelassen > 0 ? Math.floor(sam.ausgelassen) : 0,
        seit: typeof sam.seit === 'number' ? sam.seit : 0,
      };
    }
    for (const w of Array.isArray(j?.wartet) ? (j.wartet as unknown[]) : []) {
      const o = objekt(w);
      if (!o || typeof o.id !== 'string' || typeof o.bestellt !== 'number' || !Array.isArray(o.mails)) continue;
      s.wartet.push({ id: o.id, bestellt: o.bestellt, mails: o.mails.map(leseMailFeld).filter((m): m is Mail => m !== null) });
    }
  } catch {
    // Kaputte Datei heißt: Basis neu setzen. Mails dazwischen werden nicht eingeordnet, aber nie doppelt gemeldet.
  }
  return s;
}

function speichereStand(pfad: string, s: StandDatei): boolean {
  try {
    mkdirSync(dirname(pfad), { recursive: true });
    const zwischen = `${pfad}.${process.pid}.neu`;
    writeFileSync(zwischen, JSON.stringify({ staende: Object.fromEntries(s.staende), sammlung: s.sammlung, wartet: s.wartet }), { mode: 0o600 });
    renameSync(zwischen, pfad);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- Takt ----

export interface TaktOrt {
  /** Plugin-Datenordner (mailtriage-stand.json, mailsignal-*). */
  daten: string;
  signal: MailSignal;
  /** Wird mit klappe.zu aus dem Kontext gesetzt, das Signal liest sie. */
  klappe: { zu: boolean };
  /** Ruft ein eigenes Werkzeug (ohne Präfix) und liefert die strukturierte Antwort. Wirft bei Fehlern. */
  rufe: (name: string, args: Json) => Promise<Json>;
  /** Namen der Konten aus der Einstellung. */
  konten: () => string[];
  /** Schalter und Takt der Triage aus den Einstellungen des Plugins, live gelesen. */
  triage: () => { an: boolean; taktMin: number };
  log: (zeile: string) => void;
}

type Kopf = { messageId: string | null; inReplyTo: string | null; betreff: string; empfaenger: string[]; datum: number | null };

const TOLERANZ_MS = 5 * 60 * 1000;
const RE = /^\s*((re|aw|fwd?|wg)\s*:\s*)+/i;
const normBetreff = (b: string): string => {
  let s = b.trim();
  for (;;) {
    const n = s.replace(RE, '');
    if (n === s) break;
    s = n;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
};

/** Antwort: gleiche Message-ID, oder gleiches In-Reply-To und ein gemeinsamer Empfänger. Neue Mail: gleicher Betreff und alle Empfänger. Davor Gesendetes zählt nie. */
export function istAbgeschickt(art: 'antwort' | 'neu', entwurf: Kopf, gesendet: Kopf): boolean {
  if (entwurf.datum !== null && gesendet.datum !== null && gesendet.datum < entwurf.datum - TOLERANZ_MS) return false;
  if (entwurf.messageId && gesendet.messageId && entwurf.messageId === gesendet.messageId) return true;
  const gemeinsam = entwurf.empfaenger.some((a) => gesendet.empfaenger.includes(a));
  if (art === 'antwort') return !!entwurf.inReplyTo && entwurf.inReplyTo === gesendet.inReplyTo && gemeinsam;
  if (!entwurf.empfaenger.length || normBetreff(entwurf.betreff) !== normBetreff(gesendet.betreff)) return false;
  return entwurf.empfaenger.every((a) => gesendet.empfaenger.includes(a));
}

const adressen = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).map((p) => (text(objekt(p)?.adresse) ?? '').trim().toLowerCase()).filter(Boolean))];
const datumMs = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const kopfAus = (k: Json): Kopf => ({
  messageId: text(k.message_id),
  inReplyTo: text(k.in_reply_to),
  betreff: text(k.betreff) ?? '',
  empfaenger: [...new Set([...adressen(k.an), ...adressen(k.cc)])],
  datum: datumMs(k.datum),
});

export class MailTakt {
  private nachholLetzter = 0;
  private nachholGerade = false;
  private triageLetzter = 0;
  private stand: StandDatei | null = null;
  private kopfe = new Map<string, Kopf>();
  private geprueft = new Map<string, number>();
  private gestoert = new Set<string>();
  private laeuft = false;

  constructor(private ort: TaktOrt) {}

  private standPfad = (): string => join(this.ort.daten, TRIAGE_STAND_DATEI);
  private lade(): StandDatei {
    return (this.stand ??= ladeStand(this.standPfad()));
  }

  /** Ein Takt. Wirft nur bei kaputter Eingabe (dann meldet der Kern Störung plugin.takt), alles andere wird zur Aktion stoerung oder zur Logzeile. */
  async lauf(roh: Json): Promise<{ aktionen: Aktion[] }> {
    const e = leseEingabe(roh);
    // Überlappungsschutz: ein langsamer IMAP-Zugriff hält den nächsten Takt nur auf, er staut ihn nicht an.
    if (this.laeuft) return { aktionen: [] };
    this.laeuft = true;
    try {
      this.ort.klappe.zu = e.klappeZu;
      this.ort.signal.melde(undefined, e.jetzt);
      if (!e.klappeZu && e.jetzt - this.nachholLetzter >= NACHHOL_TAKT_MS && !this.nachholGerade) void this.nachholLauf(e.jetzt);
      const stoerungen: Aktion[] = [];
      const erledigt = await this.entwurfPruefer(e, stoerungen);
      const triage = await this.triage(e, stoerungen);
      const modell = triage.filter((a) => a.art === 'modell').slice(0, MAX_MODELL_JE_TAKT);
      const rest = triage.filter((a) => a.art !== 'modell');
      return { aktionen: [...stoerungen, ...erledigt, ...rest, ...modell].slice(0, MAX_AKTIONEN) };
    } finally {
      this.laeuft = false;
    }
  }

  // ---- Nachholen: stündlich, nur über das Signal, nie als Aktion ----

  private async nachholLauf(jetzt: number): Promise<void> {
    this.nachholGerade = true;
    this.nachholLetzter = jetzt;
    try {
      const r = await this.ort.rufe('nachhol_zaehle', {});
      if (typeof r.anzahl === 'number') this.ort.signal.meldeAlt(r.anzahl);
      else this.ort.log('Nachholen: ein Konto war nicht lesbar, kein Hinweis');
    } catch (e) {
      this.ort.log(`Nachholen: ${e instanceof Error ? e.name : 'Fehler'}`);
    } finally {
      this.nachholGerade = false;
    }
  }

  // ---- Entwurf-Prüfer: Review-Karte erledigen, sobald der Entwurf im Gesendet-Ordner liegt ----

  private async entwurfPruefer(e: TaktEingabe, stoerungen: Aktion[]): Promise<Aktion[]> {
    const offen = e.karten.filter((k) => k.typ === 'review' && k.entwurf !== null);
    const ids = new Set(offen.map((k) => k.id));
    for (const id of [...this.kopfe.keys()]) if (!ids.has(id)) this.kopfe.delete(id);
    for (const id of [...this.geprueft.keys()]) if (!ids.has(id)) this.geprueft.delete(id);
    const aus: Aktion[] = [];
    for (const k of offen) {
      if (e.jetzt - (this.geprueft.get(k.id) ?? 0) < ENTWURF_PAUSE_MS) continue;
      this.geprueft.set(k.id, e.jetzt);
      try {
        const a = await this.pruefeKarte(k as TaktKarte & { entwurf: NonNullable<TaktKarte['entwurf']> });
        if (a) aus.push(a);
        for (const s of [...this.gestoert]) if (s.startsWith(`${k.id}|`)) this.gestoert.delete(s);
      } catch (err) {
        // Eine Karte mit Fehler hält die anderen nicht auf. Der Text nennt nur die Karte, nie Postfachinhalt.
        const s = `${k.id}|${err instanceof Error ? err.name : 'Fehler'}`;
        this.ort.log(`Entwurf-Prüfung ${k.id}: ${err instanceof Error ? err.name : 'Fehler'}`);
        if (!this.gestoert.has(s)) {
          this.gestoert.add(s);
          stoerungen.push({ art: 'stoerung', stelle: 'mail.entwurf', text: kuerze(`Entwurf-Prüfung für Karte ${k.id} fehlgeschlagen (${err instanceof Error ? err.name : 'Fehler'})`, 300) });
        }
      }
    }
    return aus;
  }

  private async pruefeKarte(k: TaktKarte & { entwurf: NonNullable<TaktKarte['entwurf']> }): Promise<Aktion | null> {
    const ref = k.entwurf;
    if (!ref.uuid && ref.uid === null) return null;
    const r = await this.ort.rufe('entwurf_finde', { konto: ref.konto, ...(ref.uuid ? { uuid: ref.uuid } : { uid: ref.uid }) });
    const ent = objekt(r.entwurf);
    // Eine UID zählt nur mit \Draft, sonst ist es eine fremde Mail an derselben Stelle.
    const e = r.gefunden === true && ent && (ref.uuid || (Array.isArray(ent.flags) && ent.flags.includes('\\Draft'))) ? ent : null;
    if (e) this.kopfe.set(k.id, kopfAus(e));
    const gemerkt = this.kopfe.get(k.id);
    let gefunden: Kopf | null = null;
    if (gemerkt) {
      const suche =
        ref.art === 'antwort' && gemerkt.inReplyTo
          ? { in_reply_to: gemerkt.inReplyTo }
          : gemerkt.betreff
            ? { betreff: gemerkt.betreff.replace(RE, ''), ...(gemerkt.datum ? { seit_ms: gemerkt.datum - 86_400_000 } : {}) }
            : null;
      if (suche) {
        const g = await this.ort.rufe('gesendet_finde', { konto: ref.konto, ...suche });
        if (g.ordner === null) return null;
        const treffer = (Array.isArray(g.mails) ? g.mails : []).map((m) => kopfAus(objekt(m) ?? {})).filter((x) => istAbgeschickt(ref.art, gemerkt, x));
        gefunden = treffer.sort((a, b) => (b.datum ?? 0) - (a.datum ?? 0))[0] ?? null;
      }
    } else if (!e && ref.uuid) {
      // Nie gesehen und jetzt weg: nur die UUID aus der Karte bleibt zum Abgleichen.
      const g = await this.ort.rufe('gesendet_finde', { konto: ref.konto, uuid: ref.uuid });
      if (g.ordner === null) return null;
      gefunden = (Array.isArray(g.mails) ? g.mails : []).map((m) => kopfAus(objekt(m) ?? {})).sort((a, b) => (b.datum ?? 0) - (a.datum ?? 0))[0] ?? null;
    }
    // Ohne Message-ID gibt es keinen Beleg, den die Abhak-Prüfung annimmt: lieber offen lassen als raten.
    if (!gefunden?.messageId) return null;
    this.kopfe.delete(k.id);
    return { art: 'karte_erledige', id: k.id, beleg: kuerze(gefunden.messageId, 200) };
  }

  // ---- Triage ----

  private async triage(e: TaktEingabe, stoerungen: Aktion[]): Promise<Aktion[]> {
    const einst = this.ort.triage();
    const s = this.lade();
    const aus: Aktion[] = [];
    const karteOffen = e.karten.some((k) => k.titel.startsWith(TRIAGE_TITEL));
    let schmutzig = false;
    let geaendert = false;
    // Ist die Karte erledigt, fängt die Sammlung neu an.
    if (!karteOffen && (s.sammlung.einordnungen.length > 0 || s.sammlung.ausgelassen > 0)) {
      s.sammlung = { einordnungen: [], ausgelassen: 0, seit: 0 };
      schmutzig = true;
    }
    const aufnehmen = (neu: Einordnung[], ausgelassen = 0): void => {
      if (neu.length === 0 && ausgelassen === 0) return;
      if (s.sammlung.einordnungen.length === 0 && s.sammlung.ausgelassen === 0) s.sammlung.seit = e.jetzt;
      const bekannt = new Set(neu.map((x) => mailSchluessel(x.mail)));
      s.sammlung.einordnungen = [...s.sammlung.einordnungen.filter((x) => !bekannt.has(mailSchluessel(x.mail))), ...neu];
      s.sammlung.ausgelassen += ausgelassen;
      schmutzig = true;
      geaendert = true;
    };

    // 1. Ergebnisse der bestellten Modell-Aufrufe (einmalig, kommen genau im Takt danach).
    const ergebnisse = new Map(e.modell.map((m) => [m.id, m]));
    const bleibt: Wartet[] = [];
    for (const w of s.wartet) {
      const r = ergebnisse.get(w.id);
      if (!r && e.jetzt - w.bestellt < MODELL_WARTE_MS) {
        bleibt.push(w);
        continue;
      }
      // Ohne Ergebnis nach der Wartezeit oder bei Fehler zählen die Mails als "braucht dich".
      const urteile = r && 'ergebnis' in r ? leseUrteile(r.ergebnis) : new Map<number, Urteil>();
      aufnehmen(w.mails.map((m, i): Einordnung => {
        const u = urteile.get(i + 1);
        return u ? { mail: m, urteil: u, grund: 'modell' } : { mail: m, urteil: 'braucht', grund: 'rueckfall' };
      }));
      schmutzig = true;
    }
    if (bleibt.length !== s.wartet.length) s.wartet = bleibt;

    // 2. Neue Mails holen, wenn der Takt der Einstellung um ist.
    let lauf: { neu: number; ausgelassen: number; fehler: number; modell: number } | null = null;
    if (einst.an && e.jetzt - this.triageLetzter >= einst.taktMin * 60_000) {
      this.triageLetzter = e.jetzt;
      lauf = { neu: 0, ausgelassen: 0, fehler: 0, modell: 0 };
      const mails: Mail[] = [];
      const neueStaende = new Map<string, PostfachStand>();
      let ausgelassen = 0;
      for (const konto of this.ort.konten()) {
        try {
          const alt = s.staende.get(konto);
          const r = await this.ort.rufe('neue_seit', { konto, ...(alt ? { uid_next: alt.uidNext, uid_validity: alt.uidValidity } : {}) });
          const st = objekt(r.stand);
          if (!st || typeof st.uid_next !== 'number' || typeof st.uid_validity !== 'string') throw new Error('Stand fehlt');
          neueStaende.set(konto, { uidNext: st.uid_next, uidValidity: st.uid_validity });
          for (const n of Array.isArray(r.mails) ? r.mails : []) {
            const m = leseMail(konto, n);
            if (m) mails.push(m);
          }
          ausgelassen += typeof r.ausgelassen === 'number' ? r.ausgelassen : 0;
        } catch {
          // Fehlertexte können Inhalte enthalten, darum zählt nur die Zahl. Das Konto fehlt in neueStaende: sein Stand rückt nicht vor.
          lauf.fehler++;
        }
      }
      lauf.neu = mails.length;
      const regel: Einordnung[] = [];
      const rest: Mail[] = [];
      for (const m of mails) (regelUrteil(m, e.aufgaben, e.jetzt) ? regel.push({ mail: m, urteil: 'braucht', grund: 'regel' }) : rest.push(m));
      // Höchstens 3 Anfragen je Takt, jede mit bis zu 20 Mails. Der Rest zählt wie bisher bei der Obergrenze als nicht eingeordnet.
      const platz = MAX_MODELL_JE_TAKT * MAIL_JE_ANFRAGE;
      const bestellt = rest.slice(0, platz);
      ausgelassen += Math.max(0, rest.length - platz);
      for (let i = 0; i < bestellt.length; i += MAIL_JE_ANFRAGE) {
        const teil = bestellt.slice(i, i + MAIL_JE_ANFRAGE);
        const id = `triage-${e.jetzt}-${i / MAIL_JE_ANFRAGE}`;
        s.wartet.push({ id, bestellt: e.jetzt, mails: teil });
        aus.push({ art: 'modell', id, prompt: kuerze(modellPrompt(teil), 8000), max_zeichen: 4000 });
        lauf.modell++;
      }
      lauf.ausgelassen = ausgelassen;
      aufnehmen(regel, ausgelassen);
      for (const [k, st] of neueStaende) {
        const alt = s.staende.get(k);
        if (!alt || alt.uidNext !== st.uidNext || alt.uidValidity !== st.uidValidity) schmutzig = true;
        s.staende.set(k, st);
      }
      schmutzig = true;
    }

    if (schmutzig && !speichereStand(this.standPfad(), s)) {
      this.ort.log('mailtriage Stand nicht gespeichert');
      stoerungen.push({ art: 'stoerung', stelle: 'mail.triage', text: 'Triage-Stand ließ sich nicht speichern' });
    }
    if (geaendert) aus.push(triageKarte(`mail-triage-${s.sammlung.seit}`, s.sammlung.einordnungen, s.sammlung.ausgelassen));
    if (lauf) this.ort.log(`mailtriage ${new Date(e.jetzt).toISOString()} lauf neu=${lauf.neu} ausgelassen=${lauf.ausgelassen} modell=${lauf.modell} fehler=${lauf.fehler}`);
    return aus;
  }
}

/** Das Werkzeug takt für den Kern (plugin.yml: nur_dienst). Die Antwort ist als JSON-Text { aktionen }, so liest sie der Kern. */
export function taktWerkzeug(takt: MailTakt): Werkzeug {
  return {
    name: 'takt',
    beschreibung: 'Takt des Kerns: Triage, Entwurf-Prüfer, Nachholen. Antwortet mit Aktionen, die der Kern ausführt. Nur der Kern ruft es.',
    schema: {
      type: 'object',
      properties: { jetzt: { type: 'string' }, klappe: { type: 'object' }, karten: { type: 'array' }, aufgaben: { type: 'array' }, modell: { type: 'array' }, vermerke: { type: 'object' } },
      required: ['jetzt'],
    },
    aufruf: (a) => takt.lauf(a),
  };
}
