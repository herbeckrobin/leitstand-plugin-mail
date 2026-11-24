import { describe, expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { baueAntwort, baueNeu, baueRoh, ersetzeText, SIG_MARKER, signaturTeil } from '../bau.ts';
import { baueKonten } from '../konten.ts';

// A-2397: Die echte HTML-Signatur ist über 3000 Zeichen lang (body mit style, verschachtelte Tabellen, externes Bild).
// Das Plugin darf sie weder kürzen noch säubern: sie steht unverändert im HTML-Teil, der Text-Teil trägt signatur_text.

const zeile = (n: number) =>
  `<tr><td bgcolor="#f4f4f4" style="padding:4px 8px;font-family:Arial,sans-serif;font-size:12px;color:#333333">Zeile ${n}&nbsp;·&nbsp;Straße, Größe, Übergang →&nbsp;<a href="https://example.test/p/${n}" style="color:#0055aa">Mehr</a></td></tr>`;
const SIG_HTML = `<body style="margin:0;padding:0"><style>.sig td{line-height:1.4}</style><div class="sig" style="font-family:Arial,sans-serif"><table width="600" cellpadding="0" cellspacing="0"><tr><td bgcolor="#ffffff" style="padding:8px"><img src="https://example.test/logo.png" width="120" height="40" alt="Logo"></td><td style="padding:8px"><table cellpadding="0" cellspacing="0">${Array.from({ length: 12 }, (_, i) => zeile(i + 1)).join('')}</table></td></tr></table><div>Erika Muster &middot; Beispielweg 1 &rarr; <a href="https://example.test">example.test</a></div></div></body>`;
const SIG_TEXT = 'Erika Muster\nBeispielweg 1\nexample.test';

const env = {
  PLUGIN_KONTEN: JSON.stringify([{ name: 'privat', host: 'imap.example.test', benutzer: 'erika@example.test' }]),
  PLUGIN_PASSWOERTER: JSON.stringify({ privat: 'geheim-pw-123' }),
  PLUGIN_SIGNATUR_HTML: SIG_HTML,
  PLUGIN_SIGNATUR_TEXT: SIG_TEXT,
};
const absender = () => baueKonten(env)[0]!.absender;

const original = { von: { name: 'Max Beispiel', address: 'max@example.test' }, antwortAn: [], an: [], cc: [], betreff: 'Frage', messageId: '<a@example.test>', references: [], datum: new Date('2026-11-20T10:00:00Z'), text: 'Hallo', html: null };
const person = [{ address: 'x@example.test' }];
const neu = (text: string) => baueNeu({ absender: absender(), an: person, cc: [], betreff: 'b', text, signatur: true, anhaenge: [], session: 's' });
const antwort = (text: string) => baueAntwort({ original, absender: absender(), text, allen: false, signatur: true, anhaenge: [], session: 's' });

describe('HTML-Signatur über 3000 Zeichen (A-2397)', () => {
  test('die Fixture hat die geforderte Länge und Form', () => {
    expect(SIG_HTML.length).toBeGreaterThan(3000);
    for (const teil of ['<body style=', '<style>', '<div', '<table', 'bgcolor=', '<img src="https://', 'width="120" height="40"', '<a href=', '&nbsp;', '·', '→', 'Straße']) expect(SIG_HTML).toContain(teil);
    expect((SIG_HTML.match(/<table/g) ?? []).length).toBe(2);
  });

  test('Einstellung mit HTML und Text: der Absender trägt beides unverändert', () => {
    const s = signaturTeil(absender(), true)!;
    expect(s.html).toBe(`${SIG_MARKER}${SIG_HTML}`);
    expect(s.text).toBe(SIG_TEXT);
  });

  for (const [titel, bau] of [['neuer Entwurf', neu], ['Antwortentwurf', antwort]] as const) {
    test(`${titel}: multipart/alternative, HTML-Teil mit der Signatur unverändert, Text-Teil mit signatur_text`, async () => {
      // Der Text des Entwurfs ist Plaintext, mehrzeilig und mit Sonderzeichen.
      const roh = await bau('Guten Tag,\n\nbitte prüfen Sie <das> & das.\n\nDanke');
      const kopf = roh.toString().split(/\r?\n\r?\n/)[0]!;
      expect(kopf).toMatch(/Content-Type: multipart\/alternative/i);
      expect(kopf).not.toMatch(/multipart\/related/i);
      const p = await PostalMime.parse(roh);
      expect(p.html).toContain(SIG_HTML);
      expect(p.html).toContain(SIG_MARKER);
      for (const bleibt of ['<style>', '<table', '<img src="https://example.test/logo.png" width="120" height="40"', 'bgcolor="#f4f4f4"', '&nbsp;', '·', '→', 'Straße']) expect(p.html, bleibt).toContain(bleibt);
      expect((p.html!.match(/<table/g) ?? []).length).toBe(2);
      expect(p.text).toContain(SIG_TEXT);
      expect(p.text).toContain('bitte prüfen Sie <das> & das.');
      expect(p.text).not.toContain('<table');
      expect(p.attachments).toHaveLength(0);
    });
  }

  test('nur signatur_text ohne HTML: HTML-Teil baut die Signatur aus dem Text (A-2307)', async () => {
    const a = baueKonten({ ...env, PLUGIN_SIGNATUR_HTML: '' })[0]!.absender;
    expect(a.signaturHtml).toBeUndefined();
    const p = await PostalMime.parse(await baueNeu({ absender: a, an: person, cc: [], betreff: 'b', text: 'Hallo', signatur: true, anhaenge: [], session: 's' }));
    expect(p.html).toContain('<div>Erika Muster<br>Beispielweg 1<br>example.test</div>');
    expect(p.html).not.toContain('<table');
  });

  for (const [titel, bau] of [['neuer Entwurf', neu], ['Antwortentwurf', antwort]] as const) {
    test(`entwurf_aendern auf einem ${titel}: neuer Text, HTML-Signatur und Text-Signatur bleiben`, async () => {
      const a = absender();
      const alt = await PostalMime.parse(await bau('Alter Text'));
      const e = ersetzeText({ text: alt.text ?? '', html: alt.html ?? null }, 'Neuer Text\n\nZweiter Absatz', signaturTeil(a, true));
      expect(e.behalten).toBe(true);
      const roh = await baueRoh({ absender: a, an: person, cc: [], betreff: 'b', text: e.text, html: e.html, anhaenge: [], session: 's' });
      const p = await PostalMime.parse(roh);
      expect(p.html).toContain(SIG_HTML);
      expect(p.html).toContain('Neuer Text');
      expect(p.html).not.toContain('Alter Text');
      expect(p.text).toContain(SIG_TEXT);
      expect(p.text).toContain('Neuer Text');
      expect((p.html!.match(/<table/g) ?? []).length).toBe(2);
      // Ein zweites Ändern verliert nichts.
      const e2 = ersetzeText({ text: p.text ?? '', html: p.html ?? null }, 'Dritter Text', signaturTeil(a, true));
      expect(e2.behalten).toBe(true);
      expect(e2.html).toContain(SIG_HTML);
    });
  }
});
