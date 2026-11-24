import { describe, expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { baueAntwort, ersetzeText, signaturTeil, type Absender, type Original } from '../bau.ts';

// A-2389: mail_entwurf_aendern mit text soll Signatur und Zitat eines Antwortentwurfs behalten.
// Das Fixture ist der Entwurf, den mail_antwort_entwurf selbst anlegt (baueAntwort), danach von PostalMime gelesen wie im Werkzeug.

const original: Original = {
  von: { name: 'Absender Beispiel', address: 'absender@example.test' },
  an: [],
  cc: [],
  antwortAn: [],
  references: [],
  messageId: '<orig@example.test>',
  datum: new Date('2026-11-20T10:00:00Z'),
  betreff: 'Frage zum Angebot',
  text: 'Hallo,\nkönnen wir das Angebot anpassen?\nGrüße',
  html: '<div>Hallo,<br>können wir das Angebot anpassen?<br>Grüße</div>',
};

const absender = (text: string, html: string): Absender => ({
  name: 'Test Absender',
  adresse: 'ich@example.test',
  signatur: text,
  signaturHtml: () => ({ html, text, bilder: [] }),
});

async function entwurf(sig: Absender) {
  const roh = await baueAntwort({ original, absender: sig, text: 'Alter Text', allen: false, signatur: true, anhaenge: [], session: 'test' });
  const p = await PostalMime.parse(roh);
  return { text: p.text ?? '', html: p.html ?? null };
}

const faelle: Record<string, { text: string; html: string }> = {
  'Signatur mit LF': { text: 'Viele Grüße\nTest Absender\nTel 123', html: '<div>Viele Grüße<br>Test Absender<br>Tel 123</div>' },
  'Signatur mit CRLF aus der Einstellung': { text: 'Viele Grüße\r\nTest Absender\r\nTel 123', html: '<div>Viele Grüße<br>Test Absender<br>Tel 123</div>' },
  'Signatur mit Leerzeile und Zeilenendleerzeichen': { text: 'Viele Grüße \n\nTest Absender  \nTel 123', html: '<div>Viele Grüße</div><div><br></div><div>Test Absender<br>Tel&nbsp;123</div>' },
  'Signatur nur als HTML': { text: '', html: '<div>Viele Grüße<br>Test Absender</div>' },
};

describe('ersetzeText auf einem Antwortentwurf', () => {
  for (const [name, sig] of Object.entries(faelle)) {
    test(`${name}: neuer Text, Zitat und Signatur bleiben, Flag true`, async () => {
      const abs = absender(sig.text, sig.html);
      const alt = await entwurf(abs);
      const r = ersetzeText(alt, 'Neuer Text', signaturTeil(abs, true)?.text ?? '');
      expect(r.behalten).toBe(true);
      expect(r.text.startsWith('Neuer Text\n')).toBe(true);
      expect(r.text).not.toContain('Alter Text');
      expect(r.text).toContain('Test Absender');
      expect(r.text).toContain('können wir das Angebot anpassen?');
      expect(r.html).toContain('Neuer Text');
      expect(r.html).not.toContain('Alter Text');
      expect(r.html).toContain('können wir das Angebot anpassen?');
      expect(r.html).toContain('<blockquote');
    });
  }

  test('zweite Änderung auf dem Ergebnis der ersten behält ebenfalls', async () => {
    const abs = absender(faelle['Signatur mit CRLF aus der Einstellung']!.text, faelle['Signatur mit CRLF aus der Einstellung']!.html);
    const sigText = signaturTeil(abs, true)?.text ?? '';
    const erst = ersetzeText(await entwurf(abs), 'Erster Text', sigText);
    const zweit = ersetzeText(erst, 'Zweiter Text', sigText);
    expect(zweit.behalten).toBe(true);
    expect(zweit.text).toContain('können wir das Angebot anpassen?');
  });

  test('ohne erkennbare Signatur wird alles ersetzt, Flag false', () => {
    const r = ersetzeText({ text: 'Alt\n\nZitat', html: '<div>Alt</div>' }, 'Neu', 'Gruß');
    expect(r.behalten).toBe(false);
  });
});
