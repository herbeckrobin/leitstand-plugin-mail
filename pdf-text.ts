import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Block } from './html.ts';
import type { PdfDokument, PdfRenderer } from './pdf.ts';

// Textfassung der Mail als PDF (A-2396): nur Text, kein Layout der Mail, keine Bilder. Liberation Sans (OFL) wird eingebettet,
// damit Umlaute stimmen und die Textebene durchsuchbar ist (pdf-lib schreibt mit der eingebetteten Schrift eine ToUnicode-Tabelle).
// Kein Netz, kein Prozess: pdf-lib rechnet im Speicher.

const BREITE = 595.28;
const HOEHE = 841.89;
const RAND = 50;
const TEXT_BREITE = BREITE - 2 * RAND;
const GRAU = rgb(0.45, 0.45, 0.45);
const SCHWARZ = rgb(0, 0, 0);

/** Im Quelltext liegt fonts/ neben dem Modul, im Bundle (dist/server.js) eine Ebene höher. */
function schriftPfad(name: string): string {
  for (const d of [join(import.meta.dir, 'fonts'), join(import.meta.dir, '..', 'fonts')]) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`Schrift ${name} fehlt im Plugin`);
}

interface Schriften {
  normal: PDFFont;
  fett: PDFFont;
  zeichen: Set<number>;
}

/** Zeichen, die die Schrift nicht kennt (Emoji, seltene Schriften), werden zu "?", sonst bricht das Einbetten ab. */
function saeubere(t: string, z: Set<number>): string {
  let aus = '';
  for (const c of t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, ' ')) {
    const cp = c.codePointAt(0)!;
    aus += cp === 10 || z.has(cp) ? c : '?';
  }
  return aus;
}

/** Bricht Text auf die Breite um. Zu lange Wörter werden zeichenweise getrennt. */
function umbrechen(t: string, f: PDFFont, groesse: number, breite: number): string[] {
  const zeilen: string[] = [];
  for (const absatz of t.split('\n')) {
    let zeile = '';
    for (const wort of absatz.split(' ').filter(Boolean)) {
      const probe = zeile ? `${zeile} ${wort}` : wort;
      if (f.widthOfTextAtSize(probe, groesse) <= breite) {
        zeile = probe;
        continue;
      }
      if (zeile) zeilen.push(zeile);
      zeile = '';
      let rest = wort;
      while (f.widthOfTextAtSize(rest, groesse) > breite) {
        let n = rest.length;
        while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), groesse) > breite) n--;
        zeilen.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      zeile = rest;
    }
    zeilen.push(zeile);
  }
  return zeilen;
}

class Schreiber {
  private seite!: PDFPage;
  y = 0;
  constructor(
    private readonly pdf: PDFDocument,
    private readonly s: Schriften,
  ) {
    this.neueSeite();
  }
  private neueSeite(): void {
    this.seite = this.pdf.addPage([BREITE, HOEHE]);
    this.y = HOEHE - RAND;
  }
  platz(h: number): void {
    if (this.y - h < RAND) this.neueSeite();
  }
  abstand(h: number): void {
    this.y -= h;
  }
  /** Schreibt umbrochenen Text ab x. Seitenwechsel zwischen den Zeilen. */
  text(t: string, o: { groesse: number; fett?: boolean; farbe?: ReturnType<typeof rgb>; x?: number; breite?: number }): void {
    const f = o.fett ? this.s.fett : this.s.normal;
    const x = o.x ?? RAND;
    const zeilenH = o.groesse * 1.35;
    for (const z of umbrechen(saeubere(t, this.s.zeichen), f, o.groesse, o.breite ?? TEXT_BREITE - (x - RAND))) {
      this.platz(zeilenH);
      this.y -= zeilenH;
      if (z) this.seite.drawText(z, { x, y: this.y + o.groesse * 0.3, size: o.groesse, font: f, color: o.farbe ?? SCHWARZ });
    }
  }
  linie(): void {
    this.seite.drawLine({ start: { x: RAND, y: this.y }, end: { x: BREITE - RAND, y: this.y }, thickness: 0.5, color: GRAU });
  }
  tabelle(zeilen: string[][]): void {
    const spalten = Math.max(...zeilen.map((z) => z.length));
    const luecke = 8;
    const gesamt = TEXT_BREITE - luecke * (spalten - 1);
    // Breite nach Textlänge der Spalte, jede Spalte bekommt mindestens ein Zehntel.
    const gewicht = Array.from({ length: spalten }, (_, i) => Math.max(1, ...zeilen.map((z) => Math.min(60, (z[i] ?? '').length))));
    const summe = gewicht.reduce((a, b) => a + b, 0);
    const mind = gesamt * 0.1;
    const rohBreiten = gewicht.map((g) => Math.max(mind, (gesamt * g) / summe));
    const faktor = gesamt / rohBreiten.reduce((a, b) => a + b, 0);
    const breiten = rohBreiten.map((b) => b * faktor);
    const groesse = 9.5;
    const zeilenH = groesse * 1.35;
    for (const zeile of zeilen) {
      const zellen = breiten.map((b, i) => umbrechen(saeubere(zeile[i] ?? '', this.s.zeichen), this.s.normal, groesse, b));
      const hoehe = Math.max(...zellen.map((c) => c.length)) * zeilenH;
      this.platz(Math.min(hoehe, HOEHE - 2 * RAND));
      let x = RAND;
      const oben = this.y;
      zellen.forEach((c, i) => {
        c.forEach((z, n) => {
          if (z) this.seite.drawText(z, { x, y: oben - (n + 1) * zeilenH + groesse * 0.3, size: groesse, font: this.s.normal, color: SCHWARZ });
        });
        x += breiten[i]! + luecke;
      });
      this.y = oben - hoehe;
      this.y -= 3;
      this.linie();
      this.y -= 3;
    }
    this.abstand(6);
  }
}

function schreibeBlock(w: Schreiber, b: Block): void {
  if (b.art === 'ueberschrift') {
    w.abstand(4);
    w.text(b.text, { groesse: b.stufe <= 1 ? 15 : b.stufe === 2 ? 13 : 11.5, fett: true });
    w.abstand(3);
  } else if (b.art === 'absatz') {
    w.text(b.text, { groesse: 10.5 });
    w.abstand(5);
  } else if (b.art === 'liste') {
    for (const p of b.punkte) {
      w.text(`•`, { groesse: 10.5, x: RAND + 4, breite: 12 });
      // Der Punkt steht schon, der Text beginnt in derselben Zeile: eine Zeile zurück.
      w.abstand(-10.5 * 1.35);
      w.text(p, { groesse: 10.5, x: RAND + 18 });
      w.abstand(2);
    }
    w.abstand(4);
  } else {
    w.tabelle(b.zeilen);
  }
}

export const textRenderer: PdfRenderer = {
  fassung: 'text',
  rendere: async (d: PdfDokument): Promise<Uint8Array> => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    pdf.setProducer('leitstand mail');
    pdf.setCreator('leitstand mail');
    pdf.setTitle(d.kopf.betreff.slice(0, 200));
    const normal = await pdf.embedFont(readFileSync(schriftPfad('LiberationSans-Regular.ttf')), { subset: true });
    const fett = await pdf.embedFont(readFileSync(schriftPfad('LiberationSans-Bold.ttf')), { subset: true });
    // Der Zeichenvorrat kommt aus der vollständigen Schrift, die Teilmenge kennt nur schon benutzte Zeichen.
    const voll = fontkit.create(readFileSync(schriftPfad('LiberationSans-Regular.ttf')));
    const zeichen = new Set<number>(('characterSet' in voll ? (voll.characterSet as number[]) : []));
    const s: Schriften = { normal, fett, zeichen };
    const w = new Schreiber(pdf, s);
    const kopf: [string, string][] = [['Von', d.kopf.von], ['Datum', d.kopf.datum]];
    for (const [name, wert] of kopf) {
      if (!wert) continue;
      w.text(name, { groesse: 9, farbe: GRAU });
      w.abstand(-9 * 1.35);
      w.text(wert, { groesse: 10, x: RAND + 48 });
    }
    w.abstand(2);
    w.text(d.kopf.betreff, { groesse: 14, fett: true });
    w.abstand(4);
    w.linie();
    w.abstand(10);
    for (const b of d.bloecke) schreibeBlock(w, b);
    return await pdf.save();
  },
};
