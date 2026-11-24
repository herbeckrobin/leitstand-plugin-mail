import { describe, expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import { baueAntwort, baueNeu, ersetzeText, signaturTeil, type Absender, type Original } from '../bau.ts';

// A-2415: Der Gruß gehört in den Mailtext, die Signatur trägt nur Name, Zeile und Kontakt.

const SIG = { text: 'Vorname Nachname\nZeile\nTel 123', html: '<div>Vorname Nachname<br>Zeile<br>Tel&nbsp;123</div>' };
const ALT_MIT_GRUSS = { text: 'Beste Grüße\nVorname Nachname\nTel 123', html: '<div>Beste Grüße<br>Vorname Nachname<br>Tel 123</div>' };

const absender = (text: string, html: string): Absender => ({
  name: 'Test Absender',
  adresse: 'ich@example.test',
  signatur: text,
  signaturHtml: () => ({ html, text, bilder: [] }),
});

const original: Original = {
  von: { name: 'Absender Beispiel', address: 'absender@example.test' },
  an: [],
  cc: [],
  antwortAn: [],
  references: [],
  messageId: '<orig@example.test>',
  datum: new Date('2026-11-20T10:00:00Z'),
  betreff: 'Frage',
  text: 'Hallo,\nbitte um Rückmeldung.',
  html: '<div>Hallo,<br>bitte um Rückmeldung.</div>',
};

const zaehle = (s: string, teil: string): number => s.split(teil).length - 1;
const GRUSSTEXT = 'Hallo,\n\nanbei der Stand.\n\nViele Grüße\nVorname';

async function lies(roh: Buffer) {
  const p = await PostalMime.parse(roh);
  return { text: p.text ?? '', html: p.html ?? '' };
}

describe('Gruß im Text, Signatur ohne Gruß', () => {
  test('neuer Entwurf: Gruß steht im HTML-Teil und im Textteil genau einmal, vor der Signatur', async () => {
    const roh = await baueNeu({ absender: absender(SIG.text, SIG.html), an: [{ address: 'an@example.test' }], cc: [], betreff: 'Test', text: GRUSSTEXT, signatur: true, anhaenge: [], session: 'test' });
    const e = await lies(roh);
    expect(zaehle(e.html, 'Viele Grüße')).toBe(1);
    expect(zaehle(e.text, 'Viele Grüße')).toBe(1);
    expect(e.text).toContain('Viele Grüße\nVorname\n\nVorname Nachname\nZeile\nTel 123');
    expect(e.text).not.toMatch(/\n\n\n/);
    expect(e.html.indexOf('Viele Grüße')).toBeLessThan(e.html.indexOf('Vorname Nachname'));
    expect(e.html).toContain('<div>Viele Grüße</div><div>Vorname</div><div><br></div><!-- leitstand-signatur -->');
  });

  test('Antwortentwurf: Gruß einmal im HTML- und im Textteil, Signatur danach, Zitat bleibt', async () => {
    const roh = await baueAntwort({ original, absender: absender(SIG.text, SIG.html), text: GRUSSTEXT, allen: false, signatur: true, anhaenge: [], session: 'test' });
    const e = await lies(roh);
    expect(zaehle(e.html, 'Viele Grüße')).toBe(1);
    expect(zaehle(e.text, 'Viele Grüße')).toBe(1);
    expect(e.text.indexOf('Viele Grüße')).toBeLessThan(e.text.indexOf('Vorname Nachname'));
    expect(e.html).toContain('<blockquote');
  });

  test('entwurf_aendern ohne text: Signatur mit Gruß wird gegen die gruß-lose getauscht, Text mit Gruß bleibt', async () => {
    const roh = await baueAntwort({ original, absender: absender(ALT_MIT_GRUSS.text, ALT_MIT_GRUSS.html), text: GRUSSTEXT, allen: false, signatur: true, anhaenge: [], session: 'test' });
    const alt = await lies(roh);
    const r = ersetzeText(alt, null, signaturTeil(absender(SIG.text, SIG.html), true));
    expect(r.signaturNeu).toBe(true);
    expect(r.zitatBehalten).toBe(true);
    expect(zaehle(r.html, 'Viele Grüße')).toBe(1);
    expect(zaehle(r.text, 'Viele Grüße')).toBe(1);
    expect(zaehle(r.html, 'Beste Grüße')).toBe(0);
    expect(zaehle(r.text, 'Beste Grüße')).toBe(0);
    expect(r.text).toContain('Zeile\nTel 123');
  });

  test('entwurf_aendern ohne text: Entwurf mit gruß-loser aktueller Signatur bleibt byte-gleich', async () => {
    const abs = absender(SIG.text, SIG.html);
    const alt = await lies(await baueAntwort({ original, absender: abs, text: GRUSSTEXT, allen: false, signatur: true, anhaenge: [], session: 'test' }));
    const r = ersetzeText(alt, null, signaturTeil(abs, true));
    expect(r.signaturNeu).toBe(false);
    expect(r.text).toBe(alt.text);
    expect(r.html).toBe(alt.html);
  });

  test('entwurf_aendern mit neuem Text samt Gruß: Signatur bleibt erkannt, Gruß einmal', async () => {
    const abs = absender(SIG.text, SIG.html);
    const alt = await lies(await baueAntwort({ original, absender: abs, text: GRUSSTEXT, allen: false, signatur: true, anhaenge: [], session: 'test' }));
    const r = ersetzeText(alt, 'Neu.\n\nBeste Grüße\nVorname', signaturTeil(abs, true));
    expect(r.signaturNeu).toBe(false);
    expect(r.behalten).toBe(true);
    expect(zaehle(r.html, 'Beste Grüße')).toBe(1);
    expect(zaehle(r.text, 'Beste Grüße')).toBe(1);
    expect(zaehle(r.text, 'Zeile')).toBe(1);
    expect(r.html).not.toContain('Viele Grüße');
  });
});
