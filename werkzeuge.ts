import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { baueDokument, type PdfRenderer } from './pdf.ts';
import { join } from 'node:path';
import PostalMime from 'postal-mime';
import { Strukturiert, WerkzeugFehler, type Aufrufer, type Werkzeug } from './typen.ts';
import { baueAntwort, baueNeu, baueRoh, ENTWURF_KOPF, entwurfKennung, ersetzeText, signaturTeil, type Absender, type Anhang, type Original, type Person } from './bau.ts';
import { leseTriage, merkeTriage, normId, zaehleAlle } from './triage.ts';
import { ImapVerbindung, type ImapLike, type ImapNachricht, type ImapSuche, type Umschlag } from './imap.ts';
import { pruefePfad, sichererName, wurzelnAusUmgebung, type Wurzeln } from './pfade.ts';

// Mail-Modul des Gateways (Präfix mail_). Lesen, suchen, Entwürfe anlegen, ändern und verschieben über IMAP.
// Versand gibt es nicht: kein SMTP, kein Transport. Entwürfe landen im Drafts-Ordner, Robin schickt sie selbst ab.
// Ins Log geht nur Werkzeug, Session, Dauer und Ergebnis, nie Betreff, Adresse oder Inhalt.

export interface Konto {
  name: string;
  absender: Absender;
  verbindung: ImapVerbindung;
  /** Gibt einen Fehlertext zurück, solange das Konto nicht benutzbar ist (etwa fehlender Zugang). Wird vor jedem Aufruf geprüft. */
  nichtBereit?: () => string | null;
  /** 'papierkorb': Löschen heißt nach \Trash verschieben (Gmail hält \Deleted plus EXPUNGE sonst in "Alle Nachrichten"). */
  loeschen?: 'expunge' | 'papierkorb';
  /** Frische Verbindung abseits der gemeinsamen (nachhol_zaehle meldet sich selbst an und ab). Wirft ohne Zugang. */
  neuerClient?: () => ImapLike | Promise<ImapLike>;
}

export interface MailOrt {
  /** Eine Funktion wird bei jedem Aufruf neu gefragt (Postfächer kommen und gehen), das enum im Schema zeigt den Stand beim Start. */
  konten: Konto[] | (() => Konto[]);
  /** Nur Mails, deren Betreff das enthält (Test-Dienst am echten Konto, damit keine Kundenmail die Session erreicht). */
  betreffFilter?: string | null;
  wurzeln?: Wurzeln;
  /** Datei der Triage-Merkliste (mail_triage_merke). Ohne sie meldet das Werkzeug, dass es nicht eingerichtet ist. */
  triageDatei?: () => string | null;
  /** Renderer für mail_als_pdf (Naht, siehe pdf.ts). Ohne ihn lehnt das Werkzeug ab. */
  pdf?: PdfRenderer;
}

const MAX_ANZAHL = 100;
const MAX_TEXT = 60_000;
const MAX_ANHANG = 25 * 1024 * 1024;
const MAX_QUELLE = 40 * 1024 * 1024;

// Argumente prüfen. Fehlertexte gehen an die Session, darum ohne Interna.
export function str(a: Record<string, unknown>, k: string, pflicht: true): string;
export function str(a: Record<string, unknown>, k: string, pflicht?: false): string | null;
export function str(a: Record<string, unknown>, k: string, pflicht = false): string | null {
  const v = a[k];
  if (v === undefined || v === null || v === '') {
    if (pflicht) throw new WerkzeugFehler(`${k} fehlt`);
    return null;
  }
  if (typeof v !== 'string') throw new WerkzeugFehler(`${k} muss Text sein`);
  return v;
}
export function zahl(a: Record<string, unknown>, k: string, std: number | null, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = a[k];
  if (v === undefined || v === null) {
    if (std === null) throw new WerkzeugFehler(`${k} fehlt`);
    return std;
  }
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new WerkzeugFehler(`${k} muss eine ganze Zahl von ${min} bis ${max} sein`);
  return n;
}
export function bool(a: Record<string, unknown>, k: string, std: boolean): boolean {
  const v = a[k];
  if (v === undefined || v === null) return std;
  if (typeof v !== 'boolean') throw new WerkzeugFehler(`${k} muss true oder false sein`);
  return v;
}
function liste(a: Record<string, unknown>, k: string): string[] {
  const v = a[k];
  if (v === undefined || v === null) return [];
  const l = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(l) || l.some((x) => typeof x !== 'string')) throw new WerkzeugFehler(`${k} muss eine Liste von Texten sein`);
  return (l as string[]).filter(Boolean);
}
const ADRESSE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/** Text für eine Kopfzeile (Betreff): CR und LF werden abgelehnt, nicht still durch Leerzeichen ersetzt. */
const KOPF_UMBRUCH = /[\r\n\u2028\u2029]/;
function kopfText(a: Record<string, unknown>, k: string, pflicht: true): string;
function kopfText(a: Record<string, unknown>, k: string, pflicht?: false): string | null;
function kopfText(a: Record<string, unknown>, k: string, pflicht = false): string | null {
  const v = pflicht ? str(a, k, true) : str(a, k);
  if (v !== null && KOPF_UMBRUCH.test(v)) throw new WerkzeugFehler(`${k}: kein Zeilenumbruch erlaubt (Kopfzeile)`);
  return v;
}
function personen(a: Record<string, unknown>, k: string): Person[] {
  return liste(a, k).map((s) => {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s);
    const p = m ? { name: (m[1] ?? '').trim() || undefined, address: m[2]!.trim() } : { address: s.trim() };
    if (p.name && KOPF_UMBRUCH.test(p.name)) throw new WerkzeugFehler(`${k}: kein Zeilenumbruch im Namen erlaubt (Kopfzeile)`);
    if (!ADRESSE.test(p.address)) throw new WerkzeugFehler(`${k}: ungültige Adresse`);
    return p;
  });
}
function datum(a: Record<string, unknown>, k: string): Date | null {
  const s = str(a, k);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new WerkzeugFehler(`${k} im Format JJJJ-MM-TT`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new WerkzeugFehler(`${k} ist kein gültiges Datum`);
  return d;
}

const adr = (l?: { name?: string; address?: string }[]): string[] => (l ?? []).map((p) => (p.name ? `${p.name} <${p.address ?? ''}>` : (p.address ?? ''))).filter(Boolean);
const iso = (d?: Date | string): string | null => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
};

type Postal = Awaited<ReturnType<typeof PostalMime.parse>>;
type PAdresse = NonNullable<Postal['from']>;
function flach(l?: PAdresse | PAdresse[]): Person[] {
  const a = l ? (Array.isArray(l) ? l : [l]) : [];
  return a.flatMap((x) => (x.group ? x.group : [x])).filter((x): x is { name: string; address: string } => !!x.address).map((x) => ({ name: x.name || undefined, address: x.address }));
}
function textAusHtml(h: string): string {
  return h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const bytes = (c: ArrayBuffer | Uint8Array | string): Buffer => (typeof c === 'string' ? Buffer.from(c) : Buffer.from(c instanceof Uint8Array ? c : new Uint8Array(c)));

export function original(p: Postal): Original {
  return {
    von: flach(p.from)[0] ?? null,
    antwortAn: flach(p.replyTo),
    an: flach(p.to),
    cc: flach(p.cc),
    betreff: p.subject ?? '',
    messageId: p.messageId ?? null,
    references: (p.references ?? '').split(/\s+/).filter(Boolean),
    datum: p.date ? new Date(p.date) : null,
    text: p.text ?? (p.html ? textAusHtml(p.html) : ''),
    html: p.html ?? null,
  };
}

const zusammenfassung = (n: ImapNachricht, ordner: string) => ({
  ordner,
  uid: n.uid,
  datum: iso(n.envelope?.date ?? n.internalDate),
  von: adr(n.envelope?.from),
  an: adr(n.envelope?.to),
  betreff: n.envelope?.subject ?? '',
  ungelesen: n.flags ? !n.flags.has('\\Seen') : null,
  groesse: n.size ?? null,
});

/** Die Kopfzeile References aus den rohen Kopfzeilen (gefaltete Zeilen werden zusammengezogen), als Liste von Message-IDs. */
export function referenzen(h?: Buffer): string[] {
  if (!h) return [];
  const m = /^references:[ \t]*((?:.*)(?:\r?\n[ \t].*)*)/im.exec(h.toString('utf8'));
  return m ? m[1]!.split(/\s+/).filter(Boolean) : [];
}

const person = (l?: { name?: string; address?: string }[]) => (l ?? []).filter((p) => p.address).map((p) => ({ name: p.name || null, adresse: p.address! }));

/** Eine Mail als Felder für den Leitstand (MCP structuredContent), ergänzt um Konto. Der Text für Sessions bleibt davon unberührt. */
const felder = (n: ImapNachricht, konto: string, ordner: string) => ({
  konto,
  ordner,
  uid: n.uid,
  message_id: n.envelope?.messageId ?? null,
  betreff: n.envelope?.subject ?? '',
  von: person(n.envelope?.from),
  an: person(n.envelope?.to),
  cc: person(n.envelope?.cc),
  datum: iso(n.envelope?.date ?? n.internalDate),
  flags: [...(n.flags ?? [])].sort(),
  in_reply_to: n.envelope?.inReplyTo ?? null,
  references: referenzen(n.headers),
});

/** Kopf einer Mail für die Kernwerkzeuge (entwurf_finde, gesendet_finde), Form wie im Vertrag mit dem Kern. */
const kopf = (n: ImapNachricht) => ({
  uid: n.uid,
  message_id: n.envelope?.messageId ?? null,
  in_reply_to: n.envelope?.inReplyTo ?? null,
  betreff: n.envelope?.subject ?? '',
  an: person(n.envelope?.to),
  cc: person(n.envelope?.cc),
  datum: iso(n.envelope?.date ?? n.internalDate),
  flags: [...(n.flags ?? [])].sort(),
});

/** Betreff ohne führende Re:/Aw:, so steht er im Gesendet-Ordner neben dem Original. */
export const ohneRe = (b: string): string => b.replace(/^\s*((re|aw)\s*:\s*)+/i, '').trim();

const MAX_NEUE = 50;
const MAX_GESENDET = 20;
const UUID_KOPF = 'X-Universally-Unique-Identifier';

/** Fehlertext für konto_pruefe: nur Art des Fehlers, nie die Antwort des Servers (kann Zugangsdaten enthalten). */
function pruefFehler(e: unknown): string {
  const x = e as { authenticationFailed?: boolean; code?: unknown; name?: unknown };
  if (x?.authenticationFailed) return 'Anmeldung abgelehnt';
  const code = typeof x?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(x.code) ? x.code : typeof x?.name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(x.name) ? x.name : 'unbekannt';
  return `Verbindung fehlgeschlagen (${code})`;
}

export function mailWerkzeuge(o: MailOrt): Werkzeug[] {
  const wurzeln = o.wurzeln ?? wurzelnAusUmgebung();
  const filter = o.betreffFilter?.trim() || null;
  const aktuell = (): Konto[] => (typeof o.konten === 'function' ? o.konten() : o.konten);
  const start = aktuell().map((k) => k.name);
  const kontoSchema = { konto: typeof o.konten === 'function' ? { type: 'string', description: `Konto, Standard ${start[0]}, beim Start vorhanden: ${start.join(', ')}` } : { type: 'string', enum: start, description: `Konto, Standard ${start[0]}` } };

  function konto(a: Record<string, unknown>): Konto {
    const liste = aktuell();
    const n = str(a, 'konto') ?? liste[0]?.name;
    const k = liste.find((x) => x.name === n);
    if (!k) throw new WerkzeugFehler(`Konto ${String(n).slice(0, 40)} gibt es nicht, vorhanden: ${liste.map((x) => x.name).join(', ')}`);
    const f = k.nichtBereit?.();
    if (f) throw new WerkzeugFehler(f);
    return k;
  }

  /** Entwurf entfernen. Muss mit offenem Ordner laufen. Gmail: in den Papierkorb, sonst bliebe er in "Alle Nachrichten". */
  async function entfernen(k: Konto, c: ImapLike, uid: number): Promise<boolean> {
    if (k.loeschen === 'papierkorb') {
      const korb = (await k.verbindung.ordner(c)).find((m) => m.specialUse === '\\Trash')?.path;
      if (!korb) throw new WerkzeugFehler('Kein Papierkorb-Ordner im Konto gefunden, nichts gelöscht');
      return !!(await c.messageMove(String(uid), korb, { uid: true }));
    }
    return c.messageDelete(String(uid), { uid: true });
  }

  async function drafts(k: Konto, c: ImapLike): Promise<string> {
    const d = (await k.verbindung.ordner(c)).find((m) => m.specialUse === '\\Drafts')?.path;
    if (!d) throw new WerkzeugFehler('Kein Entwürfe-Ordner im Konto gefunden');
    return d;
  }

  async function istGesendetOrdner(k: Konto, c: ImapLike, pfad: string): Promise<boolean> {
    const f = (await k.verbindung.ordner(c)).find((m) => m.path === pfad);
    return f?.specialUse === '\\Sent' || /(^|[/.])(sent|gesendet)( (items|messages|mail))?$/i.test(pfad);
  }

  async function ordnerPruefen(k: Konto, c: ImapLike, pfad: string): Promise<string> {
    const l = await k.verbindung.ordner(c);
    const f = l.find((m) => m.path === pfad) ?? l.find((m) => m.path.toLowerCase() === pfad.toLowerCase());
    if (!f) throw new WerkzeugFehler(`Ordner ${pfad.slice(0, 80)} gibt es nicht`);
    return f.path;
  }

  async function imOrdner<T>(c: ImapLike, pfad: string, f: () => Promise<T>): Promise<T> {
    const lock = await c.getMailboxLock(pfad);
    try {
      return await f();
    } finally {
      lock.release();
    }
  }

  const passt = (u?: Umschlag): boolean => !filter || (u?.subject ?? '').includes(filter);

  /** Liste einer Suche: `mails` ist der Text für Sessions, `felder` dasselbe strukturiert. Beide Antworten nutzen dieselben Nachrichten. */
  async function liste_(k: Konto, c: ImapLike, pfad: string, q: ImapSuche, anzahl: number) {
    const such: ImapSuche = filter ? { ...q, subject: q.subject ? q.subject : filter } : q;
    const uids = ((await c.search(Object.keys(such).length ? such : { all: true }, { uid: true })) || []).sort((a, b) => a - b).slice(-anzahl);
    const aus: ImapNachricht[] = [];
    if (uids.length) for await (const n of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true, headers: ['references'] }, { uid: true })) if (passt(n.envelope)) aus.push(n);
    aus.sort((a, b) => b.uid - a.uid);
    return { mails: aus.map((n) => zusammenfassung(n, pfad)), felder: aus.map((n) => felder(n, k.name, pfad)) };
  }

  /** Eine Nachricht ganz holen und zerlegen. Mit Filter nur, was den Filter-Betreff trägt. */
  async function hole(c: ImapLike, uid: number): Promise<{ n: ImapNachricht; p: Postal }> {
    const n = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true, size: true, source: true }, { uid: true });
    if (!n || !n.source || !passt(n.envelope)) throw new WerkzeugFehler(`Keine Mail mit UID ${uid} in diesem Ordner`);
    if (n.source.length > MAX_QUELLE) throw new WerkzeugFehler('Mail ist größer als 40 MB, bitte in Apple Mail öffnen');
    return { n, p: await PostalMime.parse(n.source) };
  }

  function dateienLesen(pfade: string[]): Anhang[] {
    let summe = 0;
    return pfade.map((p) => {
      const g = pruefePfad(p, wurzeln);
      if (g) throw new WerkzeugFehler(`Anhang ${p.slice(0, 120)}: ${g}`);
      let s;
      try {
        s = statSync(p);
      } catch {
        throw new WerkzeugFehler(`Anhang ${p.slice(0, 120)} gibt es nicht`);
      }
      if (!s.isFile()) throw new WerkzeugFehler(`Anhang ${p.slice(0, 120)} ist keine Datei`);
      summe += s.size;
      if (summe > MAX_ANHANG) throw new WerkzeugFehler('Anhänge zusammen über 25 MB');
      return { name: sichererName(p.split('/').pop() ?? 'anhang'), inhalt: readFileSync(p) };
    });
  }

  async function ablegen(k: Konto, c: ImapLike, roh: Buffer): Promise<{ ordner: string; uid: number | null; uuid: string | null; message_id: string | null }> {
    const d = await drafts(k, c);
    const r = await c.append(d, roh, ['\\Draft', '\\Seen']);
    return { ordner: d, uid: r && typeof r.uid === 'number' ? r.uid : null, ...nurKennung(roh) };
  }
  const nurKennung = (roh: Buffer) => {
    const x = entwurfKennung(roh);
    return { uuid: x.uuid, message_id: x.messageId };
  };
  /** Hinweis an die Session: Review-Karte mit diesem Feld verknüpfen, dann zeigt der Leitstand die Vorschau und schließt die Karte beim Abschicken. */
  const kartenHinweis = (konto: string, e: { uid: number | null; uuid: string | null }, art: 'antwort' | 'neu') =>
    `Für die Review-Karte zu diesem Entwurf netz_karte_neu mit typ review und diesem Feld aufrufen: entwurf ${JSON.stringify({ konto, uid: e.uid, uuid: e.uuid, art })}. Dann zeigt der Leitstand Signatur, Zitat und Anhänge und schließt die Karte, sobald Robin den Entwurf abschickt.`;

  const uidSchema = { type: 'integer', minimum: 1, description: 'UID der Mail im Ordner' };
  const ordnerSchema = { type: 'string', description: 'IMAP-Ordner, Standard INBOX' };
  // Ein einzelner Text gilt als Liste mit einem Eintrag (liste() oben). Das Schema muss ihn erlauben, sonst lehnt der Client ihn vor dem Aufruf ab (A-2402).
  const textOderListe = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };
  const pfadListe = { ...textOderListe, description: 'Absolute Pfade unter dem Hauptverzeichnis des Leitstands, ein Pfad oder eine Liste' };
  const adrListe = (d: string) => ({ ...textOderListe, description: `${d}, als adresse oder Name <adresse>, eine Adresse oder eine Liste` });

  return [
    {
      name: 'mail_posteingang',
      beschreibung: 'Neueste Mails eines Ordners (Standard INBOX), neueste zuerst: UID, Datum, Absender, Betreff, ungelesen.',
      nurLesen: true,
      schema: { type: 'object', properties: { ...kontoSchema, ordner: ordnerSchema, anzahl: { type: 'integer', minimum: 1, maximum: MAX_ANZAHL, description: 'Standard 20' }, nur_ungelesen: { type: 'boolean' } } },
      aufruf: async (a) => {
        const k = konto(a);
        const anzahl = zahl(a, 'anzahl', 20, 1, MAX_ANZAHL);
        const nurNeu = bool(a, 'nur_ungelesen', false);
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const l = await imOrdner(c, pfad, () => liste_(k, c, pfad, nurNeu ? { seen: false } : {}, anzahl));
          return new Strukturiert({ konto: k.name, ordner: pfad, mails: l.mails }, { konto: k.name, ordner: pfad, mails: l.felder });
        });
      },
    },
    {
      name: 'mail_suchen',
      beschreibung: 'Mails suchen nach Absender, Betreff und Zeitraum in einem Ordner (Standard INBOX), neueste zuerst.',
      nurLesen: true,
      schema: {
        type: 'object',
        properties: {
          ...kontoSchema,
          ordner: ordnerSchema,
          von: { type: 'string', description: 'Teil von Absender-Name oder -Adresse' },
          betreff: { type: 'string', description: 'Teil des Betreffs' },
          seit: { type: 'string', description: 'JJJJ-MM-TT, ab diesem Tag' },
          bis: { type: 'string', description: 'JJJJ-MM-TT, bis einschließlich diesem Tag' },
          anzahl: { type: 'integer', minimum: 1, maximum: MAX_ANZAHL, description: 'Standard 30' },
        },
      },
      aufruf: async (a) => {
        const k = konto(a);
        const q: ImapSuche = {};
        const von = str(a, 'von');
        const betreff = str(a, 'betreff');
        const seit = datum(a, 'seit');
        const bis = datum(a, 'bis');
        if (von) q.from = von;
        if (betreff) {
          if (filter && !betreff.includes(filter) && !filter.includes(betreff)) return new Strukturiert({ konto: k.name, mails: [] }, { konto: k.name, ordner: str(a, 'ordner') ?? 'INBOX', mails: [] });
          q.subject = betreff;
        }
        if (seit) q.since = seit;
        if (bis) q.before = new Date(bis.getTime() + 86_400_000);
        if (!Object.keys(q).length) throw new WerkzeugFehler('Mindestens eins von von, betreff, seit, bis angeben');
        const anzahl = zahl(a, 'anzahl', 30, 1, MAX_ANZAHL);
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const l = await imOrdner(c, pfad, () => liste_(k, c, pfad, q, anzahl));
          return new Strukturiert({ konto: k.name, ordner: pfad, mails: l.mails }, { konto: k.name, ordner: pfad, mails: l.felder });
        });
      },
    },
    {
      name: 'mail_lesen',
      beschreibung: 'Eine Mail lesen: Kopf, Text und Liste der Anhänge (Index, Name, Typ, Größe).',
      nurLesen: true,
      schema: { type: 'object', properties: { ...kontoSchema, ordner: ordnerSchema, uid: uidSchema }, required: ['uid'] },
      aufruf: async (a) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const { n, p } = await imOrdner(c, pfad, () => hole(c, uid));
          const o = original(p);
          const text = o.text.length > MAX_TEXT ? `${o.text.slice(0, MAX_TEXT)}\n[… gekürzt, ${o.text.length} Zeichen]` : o.text;
          return {
            konto: k.name,
            ordner: pfad,
            uid,
            datum: iso(p.date ?? n.envelope?.date),
            von: adr(flach(p.from)),
            an: adr(o.an),
            cc: adr(o.cc),
            antwort_an: adr(o.antwortAn),
            betreff: o.betreff,
            message_id: o.messageId,
            entwurf: n.flags?.has('\\Draft') ?? false,
            text,
            anhaenge: p.attachments.map((x, i) => ({ index: i, name: x.filename ?? null, typ: x.mimeType, groesse: bytes(x.content).length, inline: x.disposition === 'inline' })),
          };
        });
      },
    },
    {
      name: 'mail_anhang_speichern',
      beschreibung: 'Einen Anhang als Datei speichern. ziel ist ein vorhandener Ordner oder ein neuer Dateipfad. Überschreibt nie.',
      schema: { type: 'object', properties: { ...kontoSchema, ordner: ordnerSchema, uid: uidSchema, index: { type: 'integer', minimum: 0, description: 'Index aus mail_lesen' }, ziel: { type: 'string', description: 'Absoluter Ordner oder Dateipfad' } }, required: ['uid', 'index', 'ziel'] },
      aufruf: async (a, wer) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        const index = zahl(a, 'index', null, 0, 1000);
        let ziel = str(a, 'ziel', true);
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const { p } = await imOrdner(c, pfad, () => hole(c, uid));
          const x = p.attachments[index];
          if (!x) throw new WerkzeugFehler(`Anhang ${index} gibt es nicht, die Mail hat ${p.attachments.length}`);
          try {
            if (statSync(ziel).isDirectory()) ziel = join(ziel, sichererName(x.filename ?? `anhang-${index}`));
          } catch {
            // ziel ist ein neuer Dateipfad
          }
          const g = pruefePfad(ziel, wurzeln);
          if (g) throw new WerkzeugFehler(g);
          const inhalt = bytes(x.content);
          try {
            writeFileSync(ziel, inhalt, { flag: 'wx', mode: 0o644 });
          } catch (e) {
            if ((e as { code?: string }).code === 'EEXIST') throw new WerkzeugFehler(`${ziel} gibt es schon, nichts überschrieben`);
            throw new WerkzeugFehler('Datei ließ sich nicht schreiben');
          }
          return { gespeichert: ziel, bytes: inhalt.length, typ: x.mimeType };
        });
      },
    },
    {
      name: 'mail_als_pdf',
      beschreibung:
        'Eine Mail als PDF-Textfassung unter ziel ablegen (für Rechnungen, die nur im Mailtext stehen). Oben ein Kopf mit Von, Datum und Betreff, darunter der Text der Mail mit Absätzen, Listen und einfachen Tabellen, durchsuchbar. Bilder und das Layout der Mail fallen weg, nichts wird aus dem Netz geladen. ziel ist ein neuer absoluter Dateipfad auf .pdf, der Ordner muss es geben. Überschreibt nie.',
      schema: { type: 'object', properties: { ...kontoSchema, ordner: ordnerSchema, uid: uidSchema, ziel: { type: 'string', description: 'Absoluter Pfad der neuen PDF-Datei (.pdf)' } }, required: ['uid', 'ziel'] },
      aufruf: async (a) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        const ziel = str(a, 'ziel', true);
        if (!/\.pdf$/i.test(ziel)) throw new WerkzeugFehler('ziel muss auf .pdf enden');
        const g = pruefePfad(ziel, wurzeln);
        if (g) throw new WerkzeugFehler(g);
        if (existsSync(ziel)) throw new WerkzeugFehler(`${ziel} gibt es schon, nichts überschrieben`);
        if (!o.pdf) throw new WerkzeugFehler('PDF-Renderer ist nicht eingerichtet');
        const renderer = o.pdf;
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const { p } = await imOrdner(c, pfad, () => hole(c, uid));
          const von = flach(p.from)[0];
          const inhalt = await renderer.rendere(
            baueDokument({ von: von ? (von.name ? `${von.name} <${von.address}>` : von.address) : '', datum: p.date ? new Date(p.date) : null, betreff: p.subject ?? '', html: p.html ?? null, text: p.text ?? null }),
          );
          try {
            writeFileSync(ziel, inhalt, { flag: 'wx', mode: 0o644 });
          } catch (e) {
            if ((e as { code?: string }).code === 'EEXIST') throw new WerkzeugFehler(`${ziel} gibt es schon, nichts überschrieben`);
            throw new WerkzeugFehler('Datei ließ sich nicht schreiben');
          }
          return { gespeichert: ziel, bytes: inhalt.length, fassung: renderer.fassung };
        });
      },
    },
    {
      name: 'mail_antwort_entwurf',
      beschreibung: 'Antwort-Entwurf im Verlauf (In-Reply-To, References, Zitat, Signatur) in den Entwürfe-Ordner legen. Sendet nicht.',
      schema: {
        type: 'object',
        properties: {
          ...kontoSchema,
          ordner: ordnerSchema,
          uid: uidSchema,
          text: { type: 'string', description: 'Antworttext ohne Gruß-Signatur, die kommt automatisch' },
          allen: { type: 'boolean', description: 'Allen antworten, Standard false' },
          signatur: { type: 'boolean', description: 'Signatur anhängen, Standard true' },
          anhaenge: pfadListe,
        },
        required: ['uid', 'text'],
      },
      aufruf: async (a, wer) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        const text = str(a, 'text', true);
        const dateien = dateienLesen(liste(a, 'anhaenge'));
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const { p } = await imOrdner(c, pfad, () => hole(c, uid));
          const o = original(p);
          const imGesendet = await istGesendetOrdner(k, c, pfad);
          const roh = await baueAntwort({ original: o, absender: k.absender, text, allen: bool(a, 'allen', false), signatur: bool(a, 'signatur', true), anhaenge: dateien, session: wer.session, imGesendet });
          const r = await ablegen(k, c, roh);
          return { entwurf: r, betreff: o.betreff, im_verlauf: !!o.messageId, anhaenge: dateien.map((d) => d.name), karten_hinweis: kartenHinweis(k.name, r, 'antwort') };
        });
      },
    },
    {
      name: 'mail_entwurf_neu',
      beschreibung: 'Neuen Entwurf (ohne Verlauf) mit optionalen Anhängen in den Entwürfe-Ordner legen. Sendet nicht.',
      schema: {
        type: 'object',
        properties: { ...kontoSchema, an: adrListe('Empfänger'), cc: adrListe('Kopie'), betreff: { type: 'string' }, text: { type: 'string' }, signatur: { type: 'boolean', description: 'Standard true' }, anhaenge: pfadListe },
        required: ['an', 'betreff', 'text'],
      },
      aufruf: async (a, wer) => {
        const k = konto(a);
        const an = personen(a, 'an');
        if (!an.length) throw new WerkzeugFehler('an fehlt');
        const roh = await baueNeu({ absender: k.absender, an, cc: personen(a, 'cc'), betreff: kopfText(a, 'betreff', true), text: str(a, 'text', true), signatur: bool(a, 'signatur', true), anhaenge: dateienLesen(liste(a, 'anhaenge')), session: wer.session });
        return k.verbindung.mit(async (c) => {
          const e = await ablegen(k, c, roh);
          return { entwurf: e, karten_hinweis: kartenHinweis(k.name, e, 'neu') };
        });
      },
    },
    {
      name: 'mail_entwuerfe_liste',
      beschreibung: 'Entwürfe im Entwürfe-Ordner, neueste zuerst.',
      nurLesen: true,
      schema: { type: 'object', properties: { ...kontoSchema, anzahl: { type: 'integer', minimum: 1, maximum: MAX_ANZAHL, description: 'Standard 30' } } },
      aufruf: async (a) => {
        const k = konto(a);
        const anzahl = zahl(a, 'anzahl', 30, 1, MAX_ANZAHL);
        return k.verbindung.mit(async (c) => {
          const d = await drafts(k, c);
          const l = await imOrdner(c, d, () => liste_(k, c, d, {}, anzahl));
          return new Strukturiert({ konto: k.name, ordner: d, entwuerfe: l.mails }, { konto: k.name, ordner: d, mails: l.felder });
        });
      },
    },
    {
      name: 'mail_entwurf_aendern',
      beschreibung: 'Entwurf ändern: neu ablegen, danach den alten löschen. Neuer Text ersetzt den Text vor Signatur und Zitat, das Zitat bleibt immer. Erkennt das Werkzeug die Signatur nicht, setzt es die aktuelle neu ein (signatur_neu_gesetzt). Bestehende Anhänge bleiben, außer anhaenge_behalten ist false.',
      schema: {
        type: 'object',
        properties: {
          ...kontoSchema,
          uid: { type: 'integer', minimum: 1, description: 'UID des Entwurfs im Entwürfe-Ordner' },
          text: { type: 'string' },
          betreff: { type: 'string' },
          an: adrListe('Neue Empfänger, ersetzt die alten'),
          cc: adrListe('Neue Kopie-Empfänger, ersetzt die alten'),
          anhaenge: pfadListe,
          anhaenge_behalten: { type: 'boolean', description: 'Standard true' },
        },
        required: ['uid'],
      },
      aufruf: async (a, wer) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        const neueDateien = dateienLesen(liste(a, 'anhaenge'));
        return k.verbindung.mit(async (c) => {
          const d = await drafts(k, c);
          return imOrdner(c, d, async () => {
            const { n, p } = await hole(c, uid);
            if (!n.flags?.has('\\Draft')) throw new WerkzeugFehler(`UID ${uid} ist kein Entwurf`);
            const o = original(p);
            const t = str(a, 'text');
            const inhalt = t === null ? { text: p.text ?? '', html: p.html ?? `<div>${(p.text ?? '').replace(/\n/g, '<br>')}</div>`, behalten: true, signaturNeu: false, zitatBehalten: true, bilder: [] as Anhang[] } : ersetzeText({ text: p.text ?? '', html: p.html ?? null }, t, signaturTeil(k.absender, true));
            const alte = bool(a, 'anhaenge_behalten', true) ? p.attachments.map((x) => ({ name: x.filename ?? 'anhang', inhalt: bytes(x.content), typ: x.mimeType })) : [];
            const an = a.an === undefined ? o.an : personen(a, 'an');
            const cc = a.cc === undefined ? o.cc : personen(a, 'cc');
            const roh = await baueRoh({ absender: k.absender, an, cc, betreff: kopfText(a, 'betreff') ?? o.betreff, text: inhalt.text, html: inhalt.html, anhaenge: [...alte, ...inhalt.bilder, ...neueDateien], session: wer.session, inReplyTo: p.inReplyTo ?? null, references: o.references, uuid: entwurfKennung(n.source ?? Buffer.alloc(0)).uuid });
            const r = await c.append(d, roh, ['\\Draft', '\\Seen']);
            if (!r) throw new WerkzeugFehler('Neuer Entwurf ließ sich nicht ablegen, der alte bleibt');
            const geloescht = await entfernen(k, c, uid);
            const e = { ordner: d, uid: typeof r.uid === 'number' ? r.uid : null, ...nurKennung(roh) };
            return { entwurf: e, karten_hinweis: kartenHinweis(k.name, e, p.inReplyTo ? 'antwort' : 'neu'), alter_geloescht: geloescht, signatur_und_zitat_behalten: inhalt.behalten && inhalt.zitatBehalten, signatur_neu_gesetzt: inhalt.signaturNeu, zitat_behalten: inhalt.zitatBehalten };
          });
        });
      },
    },
    {
      name: 'mail_entwurf_loeschen',
      beschreibung: 'Einen Entwurf löschen, den das Gateway angelegt hat. Andere Entwürfe bleiben unberührt.',
      schema: { type: 'object', properties: { ...kontoSchema, uid: { type: 'integer', minimum: 1, description: 'UID im Entwürfe-Ordner' } }, required: ['uid'] },
      aufruf: async (a) => {
        const k = konto(a);
        const uid = zahl(a, 'uid', null);
        return k.verbindung.mit(async (c) => {
          const d = await drafts(k, c);
          return imOrdner(c, d, async () => {
            const { n } = await hole(c, uid);
            const kopf = (n.source ?? Buffer.alloc(0)).subarray(0, 64 * 1024).toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
            if (!n.flags?.has('\\Draft') || !new RegExp(`^${ENTWURF_KOPF}:`, 'im').test(kopf)) throw new WerkzeugFehler(`UID ${uid} ist kein Entwurf des Gateways, nichts gelöscht`);
            return { geloescht: await entfernen(k, c, uid), uid };
          });
        });
      },
    },
    {
      name: 'mail_verschieben',
      beschreibung: 'Mails in einen anderen Ordner verschieben (etwa Archiv).',
      schema: { type: 'object', properties: { ...kontoSchema, ordner: ordnerSchema, uids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'UIDs im Quellordner' }, ziel: { type: 'string', description: 'Zielordner' } }, required: ['uids', 'ziel'] },
      aufruf: async (a) => {
        const k = konto(a);
        const roh = a.uids;
        if (!Array.isArray(roh) || !roh.length || roh.length > MAX_ANZAHL || roh.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1)) throw new WerkzeugFehler(`uids muss eine Liste von 1 bis ${MAX_ANZAHL} UIDs sein`);
        const uids = roh as number[];
        return k.verbindung.mit(async (c) => {
          const pfad = await ordnerPruefen(k, c, str(a, 'ordner') ?? 'INBOX');
          const ziel = await ordnerPruefen(k, c, str(a, 'ziel', true));
          if (ziel === pfad) throw new WerkzeugFehler('Ziel ist der Quellordner');
          return imOrdner(c, pfad, async () => {
            // Nur UIDs, die es gibt (und mit Filter nur Testmails).
            const da: number[] = [];
            for await (const n of c.fetch(uids, { uid: true, envelope: true }, { uid: true })) if (passt(n.envelope)) da.push(n.uid);
            if (!da.length) throw new WerkzeugFehler('Keine der UIDs gibt es in diesem Ordner');
            const r = await c.messageMove(da.join(','), ziel, { uid: true });
            return { verschoben: r ? da.length : 0, nach: ziel, neue_uids: r && r.uidMap ? Object.fromEntries(r.uidMap) : null, fehlend: uids.filter((u) => !da.includes(u)) };
          });
        });
      },
    },
    {
      name: 'mail_triage_merke',
      beschreibung: 'Triage-Entscheidung zu einer Mail merken (gate klar oder unklar, aktion kurz). Gespeichert werden nur Message-ID, gate und aktion, kein Betreff und kein Absender. Unklare Mails zählt der Nachhol-Lauf des Leitstands nach 24 h in das Signal mit alt="1".',
      schema: { type: 'object', properties: { message_id: { type: 'string', description: 'message_id aus mail_lesen' }, gate: { type: 'string', enum: ['klar', 'unklar'] }, aktion: { type: 'string', description: 'Kurz, was daraus wurde (etwa archiviert, antwort, karte), höchstens 60 Zeichen' } }, required: ['message_id', 'gate', 'aktion'] },
      aufruf: async (a) => {
        const id = normId(str(a, 'message_id', true));
        const gate = str(a, 'gate', true);
        if (gate !== 'klar' && gate !== 'unklar') throw new WerkzeugFehler('gate muss klar oder unklar sein');
        const aktion = str(a, 'aktion', true);
        if (aktion.length > 60) throw new WerkzeugFehler('aktion höchstens 60 Zeichen');
        if (!id || id.length > 300) throw new WerkzeugFehler('message_id ungültig');
        const pfad = o.triageDatei?.();
        if (!pfad) throw new WerkzeugFehler('Triage-Merkliste nicht eingerichtet (kein Speicherort)');
        merkeTriage(pfad, id, { gate, aktion });
        return { gemerkt: true, gate };
      },
    },

    // ---- Werkzeuge für den Kern (A-2294). Antwortform: Vertrag server/mail-plugin.ts im Leitstand-Repo. Der Text enthält nur Zahlen. ----
    {
      name: 'mail_neue_seit',
      beschreibung: 'Neue INBOX-Mails seit einem Stand (uid_next und uid_validity). Ohne Stand oder bei geänderter uid_validity ist der heutige Stand die Basis und mails bleibt leer. Höchstens 50 (die neuesten), der Rest steht in ausgelassen.',
      nurLesen: true,
      schema: { type: 'object', properties: { konto: { type: 'string' }, uid_next: { type: 'integer', minimum: 1 }, uid_validity: { type: 'string' } }, required: ['konto'] },
      aufruf: async (a) => {
        const k = konto(a);
        const stand = a.uid_next === undefined || a.uid_validity === undefined ? null : { uidNext: zahl(a, 'uid_next', null), uidValidity: str(a, 'uid_validity', true) };
        return k.verbindung.mit(async (c) => {
          const s = await c.status('INBOX', { uidNext: true, uidValidity: true });
          if (typeof s.uidNext !== 'number' || s.uidNext < 1) throw new WerkzeugFehler('Konto meldet kein UIDNEXT');
          const jetzt = { uidNext: s.uidNext, uidValidity: String(s.uidValidity ?? '') };
          const gleich = stand !== null && stand.uidValidity === jetzt.uidValidity;
          const antwort = (st: typeof jetzt, mails: { uid: number; betreff: string; von: ReturnType<typeof person> }[], ausgelassen: number) =>
            new Strukturiert(`${k.name}: ${mails.length} neu, ${ausgelassen} ausgelassen`, { konto: k.name, stand: { uid_next: st.uidNext, uid_validity: st.uidValidity }, mails, ausgelassen });
          if (!gleich || jetzt.uidNext <= stand.uidNext) return antwort(gleich ? { uidNext: stand.uidNext, uidValidity: stand.uidValidity } : jetzt, [], 0);
          const alle: { uid: number; betreff: string; von: ReturnType<typeof person> }[] = [];
          await imOrdner(c, 'INBOX', async () => {
            // n:* liefert immer mindestens die letzte Mail, auch wenn ihre UID unter n liegt: darum zusätzlich filtern.
            for await (const n of c.fetch(`${stand.uidNext}:*`, { uid: true, envelope: true }, { uid: true })) {
              if (n.uid < stand.uidNext || n.uid >= jetzt.uidNext) continue;
              const von = person(n.envelope?.from);
              const betreff = (n.envelope?.subject ?? '').trim();
              if (von.length || betreff) alle.push({ uid: n.uid, betreff, von });
            }
          });
          alle.sort((x, y) => x.uid - y.uid);
          return antwort(jetzt, alle.slice(-MAX_NEUE), Math.max(0, alle.length - MAX_NEUE));
        });
      },
    },
    {
      name: 'mail_nachhol_zaehle',
      beschreibung: 'Zählt INBOX-Mails über alle Konten, die älter als 24 Stunden sind und keine Triage-Entscheidung haben oder als unklar gemerkt sind. anzahl ist null, wenn ein Konto nicht lesbar war.',
      nurLesen: true,
      schema: { type: 'object', properties: {} },
      aufruf: async () => {
        const konten = aktuell();
        const anzahl = await zaehleAlle(
          konten.map((k) => ({
            id: k.name,
            neu: () => {
              const f = k.nichtBereit?.();
              if (f || !k.neuerClient) throw new Error('Konto nicht bereit');
              return k.neuerClient();
            },
          })),
          leseTriage(o.triageDatei?.() ?? ''),
        );
        return new Strukturiert(anzahl === null ? 'nicht lesbar' : `${anzahl} liegengeblieben`, { anzahl });
      },
    },
    {
      name: 'mail_entwurf_finde',
      beschreibung: 'Einen Entwurf im Entwürfe-Ordner finden, über uuid (Kopfzeile X-Universally-Unique-Identifier) oder uid. Mit mit_inhalt kommen Text, HTML und Anhangsliste mit.',
      nurLesen: true,
      schema: { type: 'object', properties: { konto: { type: 'string' }, uuid: { type: 'string' }, uid: uidSchema, mit_inhalt: { type: 'boolean', description: 'Standard false' } }, required: ['konto'] },
      aufruf: async (a) => {
        const k = konto(a);
        const uuid = str(a, 'uuid');
        const uidArg = a.uid === undefined || a.uid === null ? null : zahl(a, 'uid', null);
        if (uidArg === null && !uuid) throw new WerkzeugFehler('uuid oder uid angeben');
        const mitInhalt = bool(a, 'mit_inhalt', false);
        return k.verbindung.mit(async (c) => {
          const d = await drafts(k, c);
          const n = await imOrdner(c, d, async (): Promise<ImapNachricht | null> => {
            let uid = uidArg;
            if (uid === null) uid = ((await c.search({ header: { [UUID_KOPF]: uuid! } }, { uid: true })) || []).sort((x, y) => y - x)[0] ?? null;
            if (uid === null) return null;
            const m = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true, internalDate: true, source: mitInhalt }, { uid: true });
            return m || null;
          });
          if (!n) return new Strukturiert('nicht gefunden', { konto: k.name, gefunden: false, entwurf: null });
          let inhalt: { text: string; html: string | null; anhaenge: { name: string | null; typ: string; groesse: number; inline: boolean }[] } | null = null;
          if (mitInhalt) {
            if (!n.source) throw new WerkzeugFehler('Entwurf ließ sich nicht laden');
            if (n.source.length > MAX_QUELLE) throw new WerkzeugFehler('Entwurf ist größer als 40 MB');
            const p = await PostalMime.parse(n.source);
            const text = original(p).text;
            inhalt = {
              text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
              html: p.html ?? null,
              anhaenge: p.attachments.map((x) => ({ name: x.filename ?? null, typ: x.mimeType, groesse: bytes(x.content).length, inline: x.disposition === 'inline' })),
            };
          }
          return new Strukturiert('gefunden', { konto: k.name, gefunden: true, entwurf: { ...kopf(n), inhalt } });
        });
      },
    },
    {
      name: 'mail_gesendet_finde',
      beschreibung: 'Köpfe passender Mails im Gesendet-Ordner (per Special-Use), neueste zuerst, höchstens 20. Genau eine Suchart: in_reply_to, betreff (ohne Re:/Aw:, optional ab seit_ms) oder uuid.',
      nurLesen: true,
      schema: {
        type: 'object',
        properties: { konto: { type: 'string' }, in_reply_to: { type: 'string' }, betreff: { type: 'string' }, seit_ms: { type: 'integer', description: 'Nur Mails ab diesem Zeitpunkt (ms seit Epoch), nur mit betreff sinnvoll' }, uuid: { type: 'string' } },
        required: ['konto'],
      },
      aufruf: async (a) => {
        const k = konto(a);
        const inReplyTo = str(a, 'in_reply_to');
        const betreff = str(a, 'betreff');
        const uuid = str(a, 'uuid');
        if ([inReplyTo, betreff, uuid].filter((x) => x !== null).length !== 1) throw new WerkzeugFehler('genau eins von in_reply_to, betreff, uuid angeben');
        const seit = a.seit_ms === undefined || a.seit_ms === null ? null : zahl(a, 'seit_ms', null, 0);
        const suche: ImapSuche = {};
        if (inReplyTo) suche.header = { 'In-Reply-To': inReplyTo };
        if (uuid) suche.header = { [UUID_KOPF]: uuid };
        if (betreff) {
          const b = ohneRe(betreff);
          if (!b) throw new WerkzeugFehler('betreff ist nach dem Entfernen von Re:/Aw: leer');
          suche.subject = b;
        }
        if (seit !== null) suche.since = new Date(seit);
        return k.verbindung.mit(async (c) => {
          const sent = (await k.verbindung.ordner(c)).find((m) => m.specialUse === '\\Sent')?.path ?? null;
          if (!sent) return new Strukturiert('kein Gesendet-Ordner', { konto: k.name, ordner: null, mails: [] });
          const mails = await imOrdner(c, sent, async () => {
            const uids = ((await c.search(suche, { uid: true })) || []).sort((x, y) => y - x).slice(0, MAX_GESENDET);
            const aus: ImapNachricht[] = [];
            if (uids.length) for await (const n of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) aus.push(n);
            // SINCE kennt nur Tage: genau filtern wir danach.
            return aus.filter((n) => seit === null || new Date(n.envelope?.date ?? n.internalDate ?? 0).getTime() >= seit).sort((x, y) => y.uid - x.uid);
          });
          return new Strukturiert(`${mails.length} gefunden`, { konto: k.name, ordner: sent, mails: mails.map(kopf) });
        });
      },
    },
    {
      name: 'mail_konto_pruefe',
      beschreibung: 'Selbsttest, nur lesend: Anmeldung und Ordner-Liste je Konto, dazu die Special-Use-Ordner Entwürfe, Gesendet, Papierkorb. Ohne konto alle Konten.',
      nurLesen: true,
      schema: { type: 'object', properties: { konto: { type: 'string' } } },
      aufruf: async (a) => {
        const alle = aktuell();
        const name = str(a, 'konto');
        const wahl = name ? alle.filter((x) => x.name === name) : alle;
        if (name && !wahl.length) throw new WerkzeugFehler(`Konto ${name.slice(0, 40)} gibt es nicht, vorhanden: ${alle.map((x) => x.name).join(', ')}`);
        const keine = { entwuerfe: null, gesendet: null, papierkorb: null };
        const konten = [];
        for (const k of wahl) {
          const f = k.nichtBereit?.();
          if (f) {
            konten.push({ konto: k.name, ok: false, fehler: f, ordner: keine });
            continue;
          }
          try {
            // Frisch anmelden: eine offene alte Verbindung würde einen inzwischen falschen Zugang verdecken.
            await k.verbindung.schliesse();
            const l = await k.verbindung.mit((c) => c.list());
            const pfad = (u: string): string | null => l.find((m) => m.specialUse === u)?.path ?? null;
            konten.push({ konto: k.name, ok: true, fehler: null, ordner: { entwuerfe: pfad('\\Drafts'), gesendet: pfad('\\Sent'), papierkorb: pfad('\\Trash') } });
          } catch (e) {
            konten.push({ konto: k.name, ok: false, fehler: pruefFehler(e), ordner: keine });
          }
        }
        return new Strukturiert(`${konten.filter((x) => x.ok).length} von ${konten.length} Konten ok`, { konten });
      },
    },
  ];
}

export type { Aufrufer };
