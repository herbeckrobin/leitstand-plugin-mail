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
      const r = ersetzeText(alt, 'Neuer Text', signaturTeil(abs, true));
      expect(r.behalten).toBe(true);
      expect(r.signaturNeu).toBe(false);
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
    const sig = signaturTeil(abs, true);
    const erst = ersetzeText(await entwurf(abs), 'Erster Text', sig);
    const zweit = ersetzeText(erst, 'Zweiter Text', sig);
    expect(zweit.behalten).toBe(true);
    expect(zweit.text).toContain('können wir das Angebot anpassen?');
  });
});

// A-2401: Zitat bleibt immer, nicht erkannte Signatur wird neu gesetzt statt weggelassen.
const SIG = { text: 'Viele Grüße\nTest Absender\nTel 123', html: '<div>Viele Grüße<br>Test Absender<br>Tel 123</div>' };
const zaehle = (s: string, teil: string): number => s.split(teil).length - 1;

describe('ersetzeText: Zitat bleibt, Signatur wird neu gesetzt', () => {
  test('nur signatur_text (div-Rückfall, kein HTML-Signaturobjekt): Antwort behält Signatur und Zitat', async () => {
    const abs: Absender = { name: 'Test Absender', adresse: 'ich@example.test', signatur: SIG.text };
    const alt = await entwurf(abs);
    expect(alt.html).toContain('<!-- leitstand-signatur -->');
    const r = ersetzeText(alt, 'Neu', signaturTeil(abs, true));
    expect(r.behalten).toBe(true);
    expect(r.zitatBehalten).toBe(true);
    expect(r.html).toContain('<blockquote');
    expect(zaehle(r.text, 'Tel 123')).toBe(1);
  });

  test('Marker vom Server entfernt (Thunderbird, SOGo), Signatur im Text vorhanden: Signatur erkannt, Zitat bleibt, keine Doppelung', async () => {
    const abs = absender(SIG.text, SIG.html);
    const alt = await entwurf(abs);
    const ohneMarker = { text: alt.text, html: (alt.html ?? '').replace('<!-- leitstand-signatur -->', '') };
    const r = ersetzeText(ohneMarker, 'Neu', signaturTeil(abs, true));
    expect(r.behalten).toBe(true);
    expect(r.signaturNeu).toBe(false);
    expect(r.html).toContain('<blockquote');
    expect(zaehle(r.html, 'Tel 123')).toBe(1);
    expect(zaehle(r.text, 'Tel 123')).toBe(1);
    expect(r.text).toContain('können wir das Angebot anpassen?');
  });

  test('nbsp, umbrochene Zeilen und Leerraum im Entwurfstext: Signatur erkannt', async () => {
    const abs = absender(SIG.text, SIG.html);
    const alt = await entwurf(abs);
    const verzerrt = { text: alt.text.replace('Tel 123', 'Tel\u00a0\u00a0123 ').replace('Viele Grüße', 'Viele  Grüße'), html: (alt.html ?? '').replace('<!-- leitstand-signatur -->', '') };
    const r = ersetzeText(verzerrt, 'Neu', signaturTeil(abs, true));
    expect(r.behalten).toBe(true);
    expect(r.zitatBehalten).toBe(true);
  });

  test('Entwurf mit alter Signatur: Zitat bleibt, aktuelle Signatur kommt neu hinein, alte ist weg', async () => {
    const alt = await entwurf(absender('Alte Grüße\nAlter Name', '<div>Alte Grüße<br>Alter Name</div>'));
    const neuAbs = absender(SIG.text, SIG.html);
    const sig = signaturTeil(neuAbs, true);
    // Marker weg, alte Signatur im Text: nicht mehr erkennbar
    const r = ersetzeText({ text: alt.text, html: (alt.html ?? '').replace('<!-- leitstand-signatur -->', '') }, 'Neu', sig);
    expect(r.behalten).toBe(false);
    expect(r.signaturNeu).toBe(true);
    expect(r.zitatBehalten).toBe(true);
    expect(r.text).toContain('Tel 123');
    expect(r.html).toContain('Tel 123');
    expect(r.text).not.toContain('Alter Name');
    expect(r.html).not.toContain('Alter Name');
    expect(r.html).toContain('<blockquote');
    expect(r.text).toContain('können wir das Angebot anpassen?');
  });

  test('Entwurf nur als Text (ohne HTML): Zitat bleibt und kommt ins HTML, Signatur wird neu gesetzt', async () => {
    const abs = absender(SIG.text, SIG.html);
    const alt = await entwurf(abs);
    const r = ersetzeText({ text: alt.text, html: null }, 'Neu', signaturTeil(abs, true));
    expect(r.behalten).toBe(true);
    expect(r.zitatBehalten).toBe(true);
    expect(r.html).toContain('<blockquote');
    expect(r.html).toContain('können wir das Angebot anpassen?');
    expect(r.html).toContain('Neu');
  });

  test('Signatur nur im zitierten Verlauf zählt nie als erkannt', () => {
    const alt = {
      text: 'Alter Text\n\nAm 20.11.2026 um 10:00 schrieb X <x@example.test>:\n\n> Gruß\n> Viele Grüße\n> Test Absender\n> Tel 123',
      html: '<div>Alter Text</div><div><br><blockquote type="cite"><div>Am 20.11.2026 um 10:00 schrieb X</div><!-- leitstand-signatur --><div>Viele Grüße<br>Test Absender<br>Tel 123</div></blockquote></div>',
    };
    const r = ersetzeText(alt, 'Neu', { text: SIG.text, html: `<!-- leitstand-signatur -->${SIG.html}`, bilder: [] });
    expect(r.behalten).toBe(false);
    expect(r.signaturNeu).toBe(true);
    expect(r.zitatBehalten).toBe(true);
    expect(r.html).toContain('<blockquote');
  });

  test('Thunderbird-Antwort mit moz-cite-prefix: Kopfzeile und Zitat bleiben', () => {
    const alt = {
      text: 'Alter Text\n\nAm 20.11.2026 10:00 schrieb X:\n> Hallo\n',
      html: '<html><body><p>Alter Text</p><div class="moz-cite-prefix">Am 20.11.2026 10:00 schrieb X:<br></div><blockquote type="cite"><p>Hallo</p></blockquote></body></html>',
    };
    const r = ersetzeText(alt, 'Neu', { text: SIG.text, html: `<!-- leitstand-signatur -->${SIG.html}`, bilder: [] });
    expect(r.zitatBehalten).toBe(true);
    expect(r.html).toContain('moz-cite-prefix');
    expect(r.html).toContain('<p>Hallo</p>');
    expect(r.html).not.toContain('Alter Text');
    expect(r.text).toContain('> Hallo');
    expect(r.text).not.toContain('Alter Text');
    expect(r.signaturNeu).toBe(true);
  });

  test('neuer Entwurf ohne Zitat: erkannte Signatur bleibt, unbekannte wird neu gesetzt', async () => {
    const abs = absender(SIG.text, SIG.html);
    const sig = signaturTeil(abs, true);
    const roh = { text: 'Alt\n\nViele Grüße\nTest Absender\nTel 123\n', html: `<html><body><div>Alt</div><div><br></div>${sig!.html}</body></html>` };
    const a = ersetzeText(roh, 'Neu', sig);
    expect(a.behalten).toBe(true);
    expect(a.zitatBehalten).toBe(false);
    expect(zaehle(a.text, 'Tel 123')).toBe(1);
    const b = ersetzeText({ text: 'Alt\n', html: '<div>Alt</div>' }, 'Neu', sig);
    expect(b.signaturNeu).toBe(true);
    expect(b.text).toBe('Neu\n\nViele Grüße\nTest Absender\nTel 123\n');
    expect(b.html).toContain('Tel 123');
    expect(b.html).not.toContain('Alt<');
  });

  test('ohne Signatur im Konto bleibt das Zitat, es kommt keine Signatur dazu', async () => {
    const keine: Absender = { name: 'Test Absender', adresse: 'ich@example.test', signatur: '' };
    const alt = await entwurf(keine);
    const r = ersetzeText(alt, 'Neu', signaturTeil(keine, true));
    expect(r.signaturNeu).toBe(false);
    expect(r.zitatBehalten).toBe(true);
    expect(r.text).toContain('können wir das Angebot anpassen?');
  });
});
