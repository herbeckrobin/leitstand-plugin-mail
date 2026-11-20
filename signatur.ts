import PostalMime from 'postal-mime';
import type { ImapLike } from './imap.ts';

// Robins Mail-Signatur kommt aus der Einstellung (einstellungen.json: mailSignaturHtml, mailSignaturText). Dieses
// Modul liefert nur die Erstbefüllung: aus Robins zuletzt gesendeter eigener Mail im Sent-Ordner (IMAP) wird der
// Signaturblock gelöst. Die Bilder der Signatur sind externe URLs, es gibt keine cid-Anhänge.

export interface Signatur {
  html: string;
  /** Klartext-Fassung für den text/plain-Teil, ohne "-- "-Trenner. */
  text: string;
  bilder: { cid: string; typ: string; inhalt: Buffer }[];
}

export const MARKER_KOMMENTAR = '<!-- Signatur';
const MAX_BLOCK = 60_000;

export function htmlZuText(h: string): string {
  return h
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((z) => z.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Der Signaturblock aus einem HTML-Teil: das div um den Marker-Kommentar, mit passendem Ende. null, wenn kein Marker da ist. */
export function schneideBlock(html: string): string | null {
  const c = html.indexOf(MARKER_KOMMENTAR);
  if (c < 0) return null;
  const davor = /<div\b[^>]*>\s*$/i.exec(html.slice(0, c));
  let start = davor ? davor.index : -1;
  if (start < 0) {
    const d = /<div\b/i.exec(html.slice(c));
    if (!d) return null;
    start = c + d.index;
  }
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = start;
  let tiefe = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    tiefe += m[1] ? -1 : 1;
    if (tiefe === 0) {
      const block = html.slice(start, re.lastIndex).trim();
      return block.length <= MAX_BLOCK ? block : null;
    }
  }
  return null;
}

/** Signatur aus den Rohdaten einer Mail, die Robin selbst gesendet hat. Zitate und Text davor gehen nicht mit. */
export async function signaturAusMail(roh: Buffer): Promise<{ html: string; text: string } | null> {
  const p = await PostalMime.parse(roh);
  const block = p.html ? schneideBlock(p.html) : null;
  return block ? { html: block, text: htmlZuText(block) } : null;
}

export type Vorschlag = { ok: true; html: string; text: string; quellUid: number } | { ok: false; fehler: string };

/** Neueste Mail im Sent-Ordner von der eigenen Adresse mit Signaturmarker. Liest höchstens `suche` Mails, schreibt nichts. */
export async function schlageSignaturVor(c: ImapLike, o: { eigeneAdresse: string; suche?: number }): Promise<Vorschlag> {
  const liste = await c.list();
  const sent = liste.find((x) => x.specialUse === '\\Sent')?.path ?? liste.find((x) => /^sent$/i.test(x.path))?.path;
  if (!sent) return { ok: false, fehler: 'Kein Sent-Ordner gefunden' };
  const lock = await c.getMailboxLock(sent);
  try {
    const uids = (await c.search({ all: true }, { uid: true })) || [];
    for (const uid of [...uids].sort((a, b) => b - a).slice(0, o.suche ?? 30)) {
      const n = await c.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!n || !n.source) continue;
      if (!(n.envelope?.from ?? []).some((a) => a.address?.toLowerCase() === o.eigeneAdresse.toLowerCase())) continue;
      const s = await signaturAusMail(n.source);
      if (s) return { ok: true, ...s, quellUid: uid };
    }
    return { ok: false, fehler: `Keine eigene Mail mit Signaturmarker unter den letzten ${o.suche ?? 30} im Sent-Ordner` };
  } finally {
    lock.release();
  }
}
