import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImapLike } from './imap.ts';

// Triage-Merkliste und Nachhol-Zählung für das Mail-Signal. Die Datei hält je Mail nur Message-ID, gate und
// aktion (plus Zeitpunkt zum Aufräumen), nie Betreff, Absender oder Inhalt. Das Gateway schreibt sie
// (mail_triage_merke), der Server liest sie beim Zählen.

export type Gate = 'klar' | 'unklar';
export type Eintrag = { gate: Gate; aktion: string; am: number };
export type Triage = Record<string, Eintrag>;

export const TRIAGE_DATEI = 'mail-triage.json';
const AUFBEWAHRUNG_MS = 90 * 24 * 60 * 60 * 1000;
export const ALT_MS = 24 * 60 * 60 * 1000;
/** Mehr als so viele alte Mails zählt ein Lauf nicht (neueste zuerst), das hält den Abruf klein. */
const MAX_PRUEFEN = 500;

export const triagePfad = (ordner: string): string => join(ordner, TRIAGE_DATEI);

export function leseTriage(pfad: string): Triage {
  try {
    const j = JSON.parse(readFileSync(pfad, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Triage) : {};
  } catch {
    return {};
  }
}

/** Trägt eine Entscheidung ein (überschreibt die zur selben Message-ID) und räumt Einträge über 90 Tage weg. */
export function merkeTriage(pfad: string, id: string, e: { gate: Gate; aktion: string }, jetzt = Date.now()): void {
  const alle = leseTriage(pfad);
  alle[id] = { gate: e.gate, aktion: e.aktion, am: jetzt };
  for (const [k, v] of Object.entries(alle)) if (typeof v?.am !== 'number' || jetzt - v.am > AUFBEWAHRUNG_MS) delete alle[k];
  writeFileSync(`${pfad}.neu`, JSON.stringify(alle));
  renameSync(`${pfad}.neu`, pfad);
}

/** Message-ID in der Form der Mail: mit spitzen Klammern verglichen wird ohne, Groß-/Kleinschreibung egal. */
export const normId = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

/** INBOX-Mails älter als 24 h, die keine Triage-Entscheidung haben oder als unklar liegen. Nur eine Zahl. */
export async function zaehleLiegengebliebene(c: ImapLike, triage: Triage, jetzt = Date.now()): Promise<number> {
  const lock = await c.getMailboxLock('INBOX');
  try {
    // BEFORE kennt nur Tage: bis einschließlich des Tages der Grenze suchen, genau filtern wir danach.
    const grenze = jetzt - ALT_MS;
    const bis = new Date(new Date(grenze).setUTCHours(0, 0, 0, 0) + 24 * 60 * 60 * 1000);
    const uids = ((await c.search({ before: bis }, { uid: true })) || []).sort((a, b) => a - b).slice(-MAX_PRUEFEN);
    if (!uids.length) return 0;
    let n = 0;
    for await (const m of c.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      const t = new Date(m.internalDate ?? m.envelope?.date ?? 0).getTime();
      if (!(t < grenze)) continue;
      const e = m.envelope?.messageId ? triage[normId(m.envelope.messageId)] : undefined;
      if (!e || e.gate === 'unklar') n++;
    }
    return n;
  } finally {
    lock.release();
  }
}

export interface NachholKonto {
  id: string;
  /** Verbindung aufbauen, wirft ohne Zugang. */
  neu: () => ImapLike | Promise<ImapLike>;
}

/** Summe über alle Konten. null, wenn ein Konto nicht lesbar war (eine Teilzahl würde den Hinweis verfälschen). */
export async function zaehleAlle(konten: NachholKonto[], triage: Triage, jetzt = Date.now()): Promise<number | null> {
  let summe = 0;
  for (const k of konten) {
    let c: ImapLike | null = null;
    try {
      c = await k.neu();
      (c as unknown as { on?: (e: string, f: () => void) => void }).on?.('error', () => {});
      await c.connect();
      summe += await zaehleLiegengebliebene(c, triage, jetzt);
    } catch {
      return null;
    } finally {
      if (c?.usable) await c.logout().catch(() => {});
    }
  }
  return summe;
}
