// HTML einer Mail zu einfachen Blöcken für die PDF-Textfassung (A-2396). Kein DOM, kein Browser, kein Netz: ein Tokenizer
// über die Tags. Skripte, Styles, Kommentare, Bilder und Frames fallen weg, nichts davon wird je geladen oder ausgeführt.

export type Block =
  | { art: 'ueberschrift'; stufe: number; text: string }
  | { art: 'absatz'; text: string }
  | { art: 'liste'; punkte: string[] }
  | { art: 'tabelle'; zeilen: string[][] };

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  middot: '·',
  rarr: '→',
  larr: '←',
  euro: '€',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '-',
  mdash: '-',
  bull: '•',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
};

export function entitaeten(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 31 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

const bereinige = (t: string): string => entitaeten(t).replace(/[​-‏⁠﻿­]/g, '').replace(/[ \t\r\n ]+/g, ' ').trim();

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'center', 'address']);
const WEG = /<(script|style|head|title|svg|object|iframe|noscript)\b[\s\S]*?<\/\1\s*>/gi;

/** HTML einer Mail zu Blöcken. Tabellen mit verschachtelten Tabellen bleiben flach: jede Tabelle liefert ihre eigenen Zeilen. */
export function htmlZuBloecken(html: string): Block[] {
  const quelle = html.replace(/<!--[\s\S]*?-->/g, '').replace(WEG, '');
  const ausgabe: Block[] = [];
  let text = '';
  let liste: string[] | null = null;
  let itemOffen = false;
  const tabellen: { zeilen: string[][]; zeile: string[] | null; zelle: string | null }[] = [];

  const aktuell = () => tabellen[tabellen.length - 1];
  const schreibe = (t: string) => {
    const tab = aktuell();
    if (tab && tab.zelle !== null) tab.zelle += t;
    else text += t;
  };
  const absatzEnde = () => {
    if (aktuell() && aktuell()!.zelle !== null) {
      aktuell()!.zelle += ' ';
      return;
    }
    const t = bereinige(text);
    text = '';
    if (!t) return;
    if (liste && itemOffen) liste.push(t);
    else ausgabe.push({ art: 'absatz', text: t });
  };
  const listeEnde = () => {
    absatzEnde();
    itemOffen = false;
    if (liste?.length) ausgabe.push({ art: 'liste', punkte: liste });
    liste = null;
  };
  const zelleEnde = () => {
    const tab = aktuell();
    if (tab?.zelle === null || !tab) return;
    tab.zeile ??= [];
    tab.zeile.push(bereinige(tab.zelle));
    tab.zelle = null;
  };
  const zeileEnde = () => {
    const tab = aktuell();
    if (!tab) return;
    zelleEnde();
    if (tab.zeile?.some((z) => z)) tab.zeilen.push(tab.zeile);
    tab.zeile = null;
  };
  const tabelleEnde = () => {
    zeileEnde();
    const tab = tabellen.pop();
    if (tab?.zeilen.length) ausgabe.push({ art: 'tabelle', zeilen: tab.zeilen });
  };

  const re = /<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>|([^<]+|<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(quelle))) {
    if (m[4] !== undefined) {
      schreibe(m[4] === '<' ? '<' : m[4]);
      continue;
    }
    const zu = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (tag === 'br') {
      if (aktuell() && aktuell()!.zelle !== null) aktuell()!.zelle += ' ';
      else absatzEnde();
    } else if (/^h[1-6]$/.test(tag)) {
      if (!zu) absatzEnde();
      else {
        const t = bereinige(text);
        text = '';
        if (aktuell() && aktuell()!.zelle !== null) continue;
        if (t) ausgabe.push({ art: 'ueberschrift', stufe: Number(tag[1]), text: t });
      }
    } else if (tag === 'ul' || tag === 'ol') {
      if (zu) listeEnde();
      else {
        listeEnde();
        liste = [];
      }
    } else if (tag === 'li') {
      absatzEnde();
      if (!zu) {
        liste ??= [];
        itemOffen = true;
      } else itemOffen = false;
    } else if (tag === 'table') {
      if (zu) tabelleEnde();
      else {
        absatzEnde();
        tabellen.push({ zeilen: [], zeile: null, zelle: null });
      }
    } else if (tag === 'tr') {
      if (zu) zeileEnde();
      else if (aktuell()) zeileEnde();
    } else if (tag === 'td' || tag === 'th') {
      if (!aktuell()) continue;
      if (zu) zelleEnde();
      else {
        zelleEnde();
        aktuell()!.zelle = '';
      }
    } else if (BLOCK_TAGS.has(tag)) {
      absatzEnde();
    }
  }
  while (tabellen.length) tabelleEnde();
  listeEnde();
  absatzEnde();
  return ausgabe;
}

/** Plaintext einer Mail zu Absätzen, Leerzeilen trennen. */
export function textZuBloecken(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((a) => a.split('\n').map((z) => z.replace(/[ \t]+/g, ' ').trim()).join('\n').trim())
    .filter(Boolean)
    .map((t): Block => ({ art: 'absatz', text: t }));
}
