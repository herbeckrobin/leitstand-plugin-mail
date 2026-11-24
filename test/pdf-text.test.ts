import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { textRenderer } from '../pdf-text.ts';
import type { PdfDokument } from '../pdf.ts';

const wurzel = mkdtempSync(join(tmpdir(), 'mail-pdftext-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));

const dokument = (bloecke: PdfDokument['bloecke']): PdfDokument => ({
  kopf: { von: 'Apple <no_reply@example.test>', datum: '20. November 2026, 11:00', betreff: 'Ihre Rechnung für Größe' },
  bloecke,
});

/** Liest die Textebene mit pdftotext, falls vorhanden (Entwicklungsrechner), sonst null. */
async function textVon(pdf: Uint8Array): Promise<string | null> {
  if (!Bun.which('pdftotext')) return null;
  const datei = join(wurzel, `t-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(datei, pdf);
  const p = Bun.spawn(['pdftotext', '-layout', datei, '-'], { stdout: 'pipe' });
  return await new Response(p.stdout).text();
}

describe('textRenderer', () => {
  test('liefert eine gültige PDF mit lesbarer Textebene samt Umlauten', async () => {
    const pdf = await textRenderer.rendere(
      dokument([
        { art: 'ueberschrift', stufe: 1, text: 'Ihre Rechnung' },
        { art: 'absatz', text: 'Grüße aus München & Köln für Grün, ß € Æ' },
        { art: 'tabelle', zeilen: [['Posten', 'Preis'], ['Größe XL', '9,99 €']] },
        { art: 'liste', punkte: ['Eins', 'Zwei'] },
      ]),
    );
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const text = await textVon(pdf);
    if (text === null) return;
    for (const s of ['Apple <no_reply@example.test>', 'Ihre Rechnung für Größe', 'Grüße aus München & Köln für Grün', '9,99 €', 'Größe XL', 'Eins', 'Zwei']) {
      expect(text).toContain(s);
    }
  });

  test('lange Mail läuft auf weitere Seiten, nichts geht verloren', async () => {
    const bloecke: PdfDokument['bloecke'] = Array.from({ length: 120 }, (_, i) => ({ art: 'absatz' as const, text: `Absatz ${i} mit Text über Größe und Maß, der lang genug ist, um irgendwann umzubrechen und Platz zu fressen, damit Seiten entstehen.` }));
    const pdf = await textRenderer.rendere(dokument(bloecke));
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(2);
    const text = await textVon(pdf);
    if (text === null) return;
    expect(text).toContain('Absatz 0 ');
    expect(text).toContain('Absatz 119 ');
  });

  test('Emoji, Steuerzeichen, lange Wörter und leere Mail brechen nicht', async () => {
    const pdf = await textRenderer.rendere(
      dokument([
        { art: 'absatz', text: 'Hallo 😀 Welt\u0000\u0007 ' + 'x'.repeat(400) },
        { art: 'tabelle', zeilen: [['a'], ['b', 'c', 'd', 'e', 'f', 'g']] },
      ]),
    );
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0);
    const leer = await textRenderer.rendere(dokument([]));
    expect((await PDFDocument.load(leer)).getPageCount()).toBe(1);
    const text = await textVon(pdf);
    if (text !== null) expect(text).toContain('Hallo ? Welt');
  });
});
