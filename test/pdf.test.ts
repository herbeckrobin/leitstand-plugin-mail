import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapLike, ImapNachricht } from '../imap.ts';
import { baueKonten } from '../konten.ts';
import { htmlZuBloecken, textZuBloecken } from '../html.ts';
import { baueDokument, type PdfDokument, type PdfRenderer } from '../pdf.ts';
import { lokaleWerkzeuge, verarbeite } from '../server.ts';
import { mailWerkzeuge } from '../werkzeuge.ts';

const wurzel = mkdtempSync(join(tmpdir(), 'mail-pdf-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));

const RECHNUNG_HTML =
  '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>' +
  '<h1>Ihre Rechnung</h1><p>Gr&uuml;&szlig;e aus M&uuml;nchen &amp; Köln für Grün</p>' +
  '<table><tr><th>Posten</th><th>Preis</th></tr><tr><td>Größe XL</td><td>9,99&nbsp;&euro;</td></tr></table>' +
  '<ul><li>Eins</li><li>Zwei</li></ul>' +
  '<img src="https://tracker.example.test/pixel.gif"><iframe src="https://evil.example.test/"></iframe>' +
  '<p>Ende<br>nächste Zeile</p></body></html>';

describe('html.ts', () => {
  test('Umlaute, Entities, Tabelle, Liste und Überschrift werden zu Blöcken', () => {
    const b = htmlZuBloecken(RECHNUNG_HTML);
    expect(b[0]).toEqual({ art: 'ueberschrift', stufe: 1, text: 'Ihre Rechnung' });
    expect(b[1]).toEqual({ art: 'absatz', text: 'Grüße aus München & Köln für Grün' });
    expect(b[2]).toEqual({ art: 'tabelle', zeilen: [['Posten', 'Preis'], ['Größe XL', '9,99 €']] });
    expect(b[3]).toEqual({ art: 'liste', punkte: ['Eins', 'Zwei'] });
    expect(b.filter((x) => x.art === 'absatz').map((x) => (x as { text: string }).text)).toContain('nächste Zeile');
  });

  test('Skript, Style, Bild und Frame tauchen nirgends auf, es gibt keine URL im Ergebnis', () => {
    const json = JSON.stringify(htmlZuBloecken(RECHNUNG_HTML));
    for (const s of ['alert', 'color:red', 'tracker', 'evil', 'http', 'pixel']) expect(json).not.toContain(s);
  });

  test('Plaintext wird zu Absätzen, kaputtes HTML bricht nicht', () => {
    expect(textZuBloecken('Hallo\r\nWelt\n\n\nZweiter  Absatz')).toEqual([
      { art: 'absatz', text: 'Hallo\nWelt' },
      { art: 'absatz', text: 'Zweiter Absatz' },
    ]);
    expect(() => htmlZuBloecken('<table><tr><td>x<p>a < b</div></li></ul>')).not.toThrow();
    expect(htmlZuBloecken('')).toEqual([]);
  });

  test('numerische Entities und ungültige Zeichen', () => {
    expect(htmlZuBloecken('<p>&#228;&#x00F6;&#0;&#xD800;</p>')).toEqual([{ art: 'absatz', text: 'äö' }]);
  });
});

describe('baueDokument', () => {
  test('Kopf mit Absender, Datum und Betreff, HTML bevorzugt, Plaintext als Rückfall', () => {
    const d = baueDokument({ von: 'Apple <a@example.test>', datum: new Date('2026-11-20T10:00:00Z'), betreff: 'Rechnung', html: '<p>Hallo</p>', text: 'Plain' });
    expect(d.kopf.von).toBe('Apple <a@example.test>');
    expect(d.kopf.datum).toContain('2026');
    expect(d.kopf.betreff).toBe('Rechnung');
    expect(d.bloecke).toEqual([{ art: 'absatz', text: 'Hallo' }]);
    expect(baueDokument({ von: '', datum: null, betreff: '', html: '<img src="x">', text: 'Plain' }).bloecke).toEqual([{ art: 'absatz', text: 'Plain' }]);
    expect(baueDokument({ von: '', datum: null, betreff: '', html: null, text: null }).kopf).toEqual({ von: '', datum: '', betreff: '(ohne Betreff)' });
  });
});

/** Mail 7 mit HTML, kein Anhang, mit externem Bild. */
class HtmlDoppel implements ImapLike {
  usable = true;
  async connect() {}
  async logout() {
    this.usable = false;
  }
  async list() {
    return [{ path: 'INBOX' }];
  }
  async status() {
    return { uidNext: 8, uidValidity: 1 };
  }
  async getMailboxLock() {
    return { release() {} };
  }
  async search() {
    return [7];
  }
  async *fetch(): AsyncIterable<ImapNachricht> {}
  async fetchOne(uid: string): Promise<ImapNachricht | false> {
    if (uid !== '7') return false;
    const source = Buffer.from(
      'From: Apple <no_reply@example.test>\r\nTo: robin@example.test\r\nSubject: =?UTF-8?Q?Ihre_Rechnung_f=C3=BCr_Gr=C3=B6=C3=9Fe?=\r\nDate: Fri, 20 Nov 2026 10:00:00 +0000\r\nMessage-ID: <r7@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' + RECHNUNG_HTML,
    );
    return { uid: 7, envelope: { subject: 'Ihre Rechnung für Größe', from: [{ name: 'Apple', address: 'no_reply@example.test' }] }, flags: new Set<string>(), source };
  }
  async append() {
    return { uid: 9 };
  }
  async messageDelete() {
    return true;
  }
  async messageMove() {
    return {};
  }
}

const KONTEN = JSON.stringify([{ name: 'privat', host: 'imap.example.test', benutzer: 'robin@example.test' }]);
const PASS = JSON.stringify({ privat: 'geheim-pw-123' });
const env = { PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS };

describe('mail_als_pdf', () => {
  const haupt = join(wurzel, 'archiv');
  mkdirSync(haupt);
  const aussen = join(wurzel, 'aussen');
  mkdirSync(aussen);
  let zuletzt: PdfDokument | null = null;
  const renderer: PdfRenderer = {
    fassung: 'text',
    rendere: async (d) => {
      zuletzt = d;
      return new TextEncoder().encode('%PDF-Test');
    },
  };
  const defs = (pdf: PdfRenderer | undefined) => lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten(env, () => new HtmlDoppel()), wurzeln: { haupt: () => haupt }, pdf }));
  const rufe = async (a: Record<string, unknown>, pdf?: PdfRenderer | null) => {
    const r = await verarbeite(defs(pdf === null ? undefined : (pdf ?? renderer)), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'als_pdf', arguments: a } });
    const res = r!.result as { isError?: boolean; content: { text: string }[] };
    return { isError: res.isError, text: res.content[0]!.text };
  };

  test('legt die PDF an, meldet Pfad, Bytes und Fassung, der Kopf trägt Absender, Datum, Betreff', async () => {
    const ziel = join(haupt, 'apple-rechnung.pdf');
    const r = await rufe({ uid: 7, ziel });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.text)).toEqual({ gespeichert: ziel, bytes: 9, fassung: 'text' });
    expect(readFileSync(ziel, 'utf8')).toBe('%PDF-Test');
    expect(zuletzt!.kopf.von).toBe('Apple <no_reply@example.test>');
    expect(zuletzt!.kopf.betreff).toBe('Ihre Rechnung für Größe');
    expect(zuletzt!.kopf.datum).toContain('2026');
    const json = JSON.stringify(zuletzt!.bloecke);
    expect(json).toContain('Grüße aus München');
    expect(json).toContain('"tabelle"');
    expect(json).not.toContain('tracker');
  });

  test('Ziel existiert schon: abgelehnt, Inhalt bleibt', async () => {
    const ziel = join(haupt, 'da.pdf');
    writeFileSync(ziel, 'alt');
    const r = await rufe({ uid: 7, ziel });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('gibt es schon');
    expect(readFileSync(ziel, 'utf8')).toBe('alt');
  });

  test('Pfad außerhalb, relativ, versteckt, Symlink hinaus und fehlender Ordner werden abgelehnt', async () => {
    for (const ziel of [join(aussen, 'x.pdf'), 'x.pdf', join(haupt, '.versteckt', 'x.pdf'), join(haupt, 'gibtsnicht', 'x.pdf'), join(haupt, '..', 'aussen', 'x.pdf')]) {
      const r = await rufe({ uid: 7, ziel });
      expect(r.isError).toBe(true);
    }
    symlinkSync(aussen, join(haupt, 'link'));
    expect((await rufe({ uid: 7, ziel: join(haupt, 'link', 'x.pdf') })).isError).toBe(true);
    expect(existsSync(join(aussen, 'x.pdf'))).toBe(false);
  });

  test('ziel ohne .pdf, fehlende UID, fehlender Renderer', async () => {
    expect((await rufe({ uid: 7, ziel: join(haupt, 'x.txt') })).text).toContain('.pdf');
    expect((await rufe({ uid: 99, ziel: join(haupt, 'u.pdf') })).isError).toBe(true);
    const ohne = await rufe({ uid: 7, ziel: join(haupt, 'o.pdf') }, null);
    expect(ohne.isError).toBe(true);
    expect(existsSync(join(haupt, 'o.pdf'))).toBe(false);
  });
});
