import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { htmlZuText, type Signatur } from './signatur.ts';

/** Marker vor der Signatur im Entwurfs-HTML. Gleicher Wert wie im Kern (domain/entwurf-vorschau.ts), sonst erkennt die Vorschau die Signatur nicht. */
export const SIG_MARKER = '<!-- leitstand-signatur -->';

// Entwürfe bauen, wie die Probe A-1441 (von Robin abgenommen): Antwort im Verlauf mit In-Reply-To, References,
// Zitat mit deutscher Kopfzeile wie Apple Mail, Signatur, Anhang. Nur MailComposer, kein Transport: nodemailer
// selbst wird nie importiert, ein Test prüft im Bundle, dass kein SMTP-Code mitkommt.
// Jeder Entwurf ist multipart/alternative (Text und HTML). Die Signatur ist Robins echte HTML-Signatur (signatur.ts),
// ohne "-- "-Trenner. Hat sie eingebettete Bilder, wird daraus multipart/related mit cid. Fehlt die Kopie, bleibt die
// Text-Signatur aus dem Absender.

export interface Absender {
  name: string;
  adresse: string;
  /** Text-Signatur, Rückfall wenn es keine HTML-Kopie gibt. */
  signatur: string;
  /** Liefert Robins HTML-Signatur, bei jedem Entwurf neu gelesen, damit eine Auffrischung ohne Neustart greift. */
  signaturHtml?: () => Signatur | null;
}

export interface Anhang {
  name: string;
  inhalt: Buffer;
  typ?: string;
  /** Eingebettetes Bild (Content-ID), das der HTML-Teil mit cid: anspricht. */
  cid?: string;
}

export interface Person {
  name?: string;
  address: string;
}

/** Was vom Original einer Antwort gebraucht wird (aus postal-mime). */
export interface Original {
  von: Person | null;
  antwortAn: Person[];
  an: Person[];
  cc: Person[];
  betreff: string;
  messageId: string | null;
  references: string[];
  datum: Date | null;
  text: string;
  html: string | null;
}

export const ENTWURF_KOPF = 'X-Leitstand-Entwurf';

/**
 * Kennung, an der Mail.app einen IMAP-Entwurf als seinen eigenen erkennt und beim Senden aus Drafts entfernt.
 * Ohne sie bleibt der Entwurf liegen (A-1530: UID 1881 bis 1883). Quelle: apple-mail-fast-mcp Issue 472, dort
 * trägt ein von Mail.app gespeicherter Entwurf beide Kopfzeilen, und nach dem Setzen räumten 10 von 10 Entwürfen sich weg.
 */
export const APPLE_ENTWURF_TYP = 'com.apple.mail-draft';

/** Kopfzeilen jedes Gateway-Entwurfs: Sitzung, Apple-Entwurfskennung und eine neue UUID (Großbuchstaben wie bei Mail.app). */
export const entwurfKoepfe = (session: string, uuid?: string | null): Record<string, string> => ({
  [ENTWURF_KOPF]: session,
  'X-Uniform-Type-Identifier': APPLE_ENTWURF_TYP,
  'X-Universally-Unique-Identifier': uuid || randomUUID().toUpperCase(),
});

/** UUID und Message-ID aus dem Kopf einer gebauten Mail. Der Entwurf wird über die UUID wiedergefunden, auch wenn Apple Mail ihn mit neuer UID speichert. */
export function entwurfKennung(roh: Buffer): { uuid: string | null; messageId: string | null } {
  const kopf = roh.subarray(0, 64 * 1024).toString('utf8').split(/\r?\n\r?\n/)[0]?.replace(/\r?\n[ \t]+/g, ' ') ?? '';
  const feld = (n: string): string | null => new RegExp(`^${n}:[ \\t]*(.+)$`, 'im').exec(kopf)?.[1]?.trim() ?? null;
  return { uuid: feld('X-Universally-Unique-Identifier'), messageId: feld('Message-ID') };
}

export const zitat = (t: string): string =>
  t
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((z) => (z.startsWith('>') ? `>${z}` : `> ${z}`))
    .join('\n');

export const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Kopfzeile wie Apple Mail auf Deutsch: "Am 01.11.2026 um 23:40 schrieb Name <adresse>:" */
export function kopfzeile(datum: Date, name: string, adresse: string): string {
  const d = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(datum);
  const z = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(datum);
  return `Am ${d} um ${z} schrieb ${name ? `${name} ` : ''}<${adresse}>:`;
}

export function betreffRe(b: string): string {
  return /^\s*(re|aw):/i.test(b) ? b : `Re: ${b}`;
}

const html = (inhalt: string): string =>
  `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body style="overflow-wrap: break-word; -webkit-nbsp-mode: space; line-break: after-white-space;">${inhalt}</body></html>`;
const absaetze = (t: string): string =>
  t
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((z) => (z ? `<div>${esc(z)}</div>` : '<div><br></div>'))
    .join('');

/** Signatur eines Entwurfs: Robins HTML-Kopie, sonst die Text-Signatur, sonst nichts. */
export function signaturTeil(a: Absender, an: boolean): { text: string; html: string; bilder: Anhang[] } | null {
  if (!an) return null;
  const s = a.signaturHtml?.() ?? null;
  if (s) return { text: s.text.trim() || htmlZuText(s.html), html: `${SIG_MARKER}${s.html}`, bilder: s.bilder.map((b) => ({ name: b.cid, inhalt: b.inhalt, typ: b.typ, cid: b.cid })) };
  if (!a.signatur) return null;
  return { text: a.signatur.trim(), html: `${SIG_MARKER}<div>${a.signatur.trim().split('\n').map(esc).join('<br>')}</div>`, bilder: [] };
}

const klein = (a: string): string => a.trim().toLowerCase();

/**
 * Empfänger einer Antwort: Reply-To oder Absender, bei allen dazu An und Cc ohne die eigene Adresse.
 * Eine eigene Mail (Gesendet-Ordner oder From ist das eigene Konto) hat keinen Gegenüber im From: dort gehen To und Cc
 * der Originalmail an den Entwurf, sonst ginge die Nachfrage an einen selbst (A-2259).
 */
export function empfaenger(o: Original, eigen: string, allen: boolean, imGesendet = false): { an: Person[]; cc: Person[] } {
  if (imGesendet || (o.von && klein(o.von.address) === klein(eigen))) {
    const fremd = (l: Person[]) => l.filter((p) => klein(p.address) && klein(p.address) !== klein(eigen));
    const an = fremd(o.an);
    if (an.length) {
      const schon = new Set(an.map((p) => klein(p.address)));
      return { an, cc: fremd(o.cc).filter((p) => !schon.has(klein(p.address))) };
    }
  }
  const an = o.antwortAn.length ? o.antwortAn : o.von ? [o.von] : [];
  if (!allen) return { an, cc: [] };
  const schon = new Set([klein(eigen), ...an.map((p) => klein(p.address))]);
  const cc: Person[] = [];
  for (const p of [...o.an, ...o.cc]) {
    const k = klein(p.address);
    if (!k || schon.has(k)) continue;
    schon.add(k);
    cc.push(p);
  }
  return { an, cc };
}

async function baue(opt: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new MailComposer(opt).compile().build();
}

const anhaenge = (a: Anhang[]) =>
  a.map((x) => ({ filename: x.name, content: x.inhalt, ...(x.typ ? { contentType: x.typ } : {}), ...(x.cid ? { cid: x.cid, contentDisposition: 'inline' as const } : {}) }));

/** Antwort-Entwurf im Verlauf. Gibt die Rohdaten für APPEND zurück. */
export function baueAntwort(e: { original: Original; absender: Absender; text: string; allen: boolean; signatur: boolean; anhaenge: Anhang[]; session: string; imGesendet?: boolean }): Promise<Buffer> {
  const o = e.original;
  const { an, cc } = empfaenger(o, e.absender.adresse, e.allen, e.imGesendet);
  const refs = [...o.references, ...(o.messageId ? [o.messageId] : [])];
  const von = o.von ?? { address: '' };
  const k = kopfzeile(o.datum ?? new Date(), von.name ?? '', von.address);
  const sig = signaturTeil(e.absender, e.signatur);
  const text = `${e.text.trimEnd()}\n\n${sig ? `${sig.text}\n\n` : ''}${k}\n\n${zitat(o.text)}\n`;
  const zitatHtml = o.html ?? `<div>${esc(o.text).replace(/\n/g, '<br>')}</div>`;
  const h = html(`${absaetze(e.text.trimEnd())}<div><br></div>${sig ? sig.html : ''}<div><br><blockquote type="cite"><div>${esc(k)}</div><br>${zitatHtml}</blockquote></div><br>`);
  return baue({
    from: { name: e.absender.name, address: e.absender.adresse },
    to: an.map((p) => ({ name: p.name ?? '', address: p.address })),
    cc: cc.length ? cc.map((p) => ({ name: p.name ?? '', address: p.address })) : undefined,
    subject: betreffRe(o.betreff),
    inReplyTo: o.messageId ?? undefined,
    references: refs.length ? refs : undefined,
    text,
    html: h,
    attachments: anhaenge([...e.anhaenge, ...(sig?.bilder ?? [])]),
    headers: entwurfKoepfe(e.session),
  });
}

/**
 * Neuer Text für einen bestehenden Entwurf. Signatur und Zitat bleiben, wenn die Signatur zu erkennen ist: im HTML am
 * Marker (SIG_MARKER), im Text als Block sigText. Entwürfe aus der Zeit vor der HTML-Signatur trugen den Trenner
 * "-- " (Text: Zeile "-- ", HTML: <div>-- <br>), auch der gilt noch. Sonst wird der ganze Text ersetzt, behalten ist false.
 */
export function ersetzeText(alt: { text: string; html: string | null }, neu: string, sigText = ''): { text: string; html: string; behalten: boolean } {
  const t = alt.text.replace(/\r\n/g, '\n');
  const body = neu.trimEnd();
  const voll = { text: `${body}\n`, html: html(absaetze(body)), behalten: false };
  if (!alt.html) return voll;
  let hi = alt.html.indexOf(SIG_MARKER);
  let ti = -1;
  if (hi >= 0) {
    const s = sigText.trim();
    ti = s ? t.indexOf(`\n\n${s}`) : -1;
    if (ti >= 0) {
      const hEnde = alt.html.lastIndexOf('</body>');
      const rest = alt.html.slice(hi, hEnde > hi ? hEnde : undefined);
      return { text: `${body}${t.slice(ti)}`, html: html(`${absaetze(body)}<div><br></div>${rest}`), behalten: true };
    }
    return voll;
  }
  hi = alt.html.indexOf('<div>-- <br>');
  ti = t.indexOf('\n-- \n');
  if (ti < 0 || hi < 0) return voll;
  const hEnde = alt.html.lastIndexOf('</body>');
  const rest = alt.html.slice(hi, hEnde > hi ? hEnde : undefined);
  return { text: `${body}\n${t.slice(ti)}`, html: html(`${absaetze(body)}<div><br></div>${rest}`), behalten: true };
}

/** Entwurf aus fertigem Text und HTML (für entwurf_aendern), Verlaufs-Kopfzeilen werden übernommen. */
export function baueRoh(e: { absender: Absender; an: Person[]; cc: Person[]; betreff: string; text: string; html: string; anhaenge: Anhang[]; session: string; inReplyTo?: string | null; references?: string[]; uuid?: string | null }): Promise<Buffer> {
  return baue({
    from: { name: e.absender.name, address: e.absender.adresse },
    to: e.an.map((p) => ({ name: p.name ?? '', address: p.address })),
    cc: e.cc.length ? e.cc.map((p) => ({ name: p.name ?? '', address: p.address })) : undefined,
    subject: e.betreff,
    inReplyTo: e.inReplyTo ?? undefined,
    references: e.references?.length ? e.references : undefined,
    text: e.text,
    html: e.html,
    attachments: anhaenge(e.anhaenge),
    headers: entwurfKoepfe(e.session, e.uuid),
  });
}

/** Neuer Entwurf ohne Verlauf. */
export function baueNeu(e: { absender: Absender; an: Person[]; cc: Person[]; betreff: string; text: string; signatur: boolean; anhaenge: Anhang[]; session: string; inReplyTo?: string | null; references?: string[] }): Promise<Buffer> {
  const sig = signaturTeil(e.absender, e.signatur);
  return baue({
    from: { name: e.absender.name, address: e.absender.adresse },
    to: e.an.map((p) => ({ name: p.name ?? '', address: p.address })),
    cc: e.cc.length ? e.cc.map((p) => ({ name: p.name ?? '', address: p.address })) : undefined,
    subject: e.betreff,
    inReplyTo: e.inReplyTo ?? undefined,
    references: e.references?.length ? e.references : undefined,
    text: `${e.text.trimEnd()}\n${sig ? `\n${sig.text}\n` : ''}`,
    html: html(`${absaetze(e.text.trimEnd())}${sig ? `<div><br></div>${sig.html}` : ''}`),
    attachments: anhaenge([...e.anhaenge, ...(sig?.bilder ?? [])]),
    headers: entwurfKoepfe(e.session),
  });
}
