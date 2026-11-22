import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailSignal, nachholText, signalText } from '../signal.ts';

// Portiert aus test/mail-gleichlauf.test.ts des Kerns (Zweig js-leitstand-mailprozess, b09679c0): Text, Puffer-Datei
// und Nachhol-Datei mit ihren Feldern müssen nach dem Umzug gleich bleiben.

const wurzel = mkdtempSync(join(tmpdir(), 'mail-signal-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));
let zaehler = 0;
const neuerOrdner = (): string => {
  const o = join(wurzel, `t${zaehler++}`);
  mkdirSync(o, { recursive: true });
  return o;
};
const lies = (pfad: string): unknown => JSON.parse(readFileSync(pfad, 'utf8'));

// Kern-Regex für Rahmen roh (Vertrag 4): passt der Text nicht, maskiert der Kern ihn.
const RAHMEN = /^<channel source="[a-z-]+"( [a-z]+="[^"<>]*")*>[^<]{0,500}<\/channel>$/;

describe('Hinweisdatei', () => {
  test('Prüfsumme gleich wie MAILSIGNAL_HINWEIS im Kern, höchstens 4000 Zeichen', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'hinweise', 'mail-neu.md'), 'utf8');
    expect(createHash('sha256').update(text).digest('hex')).toBe('61bd21bcf49834fa3ff9410f0a90cc5b320f841e760c3c60193a687aaa8425e2');
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});

describe('signalText', () => {
  test('Eingang, gesendet, unbekannt, gesammelt', () => {
    expect(signalText({ anzahl: 2, gesendet: 1 }, false)).toBe('<channel source="mailsignal" anzahl="2" gesendet="1">2 neue Mails, 1 gesendet</channel>');
    expect(signalText({ anzahl: 1, gesendet: 0 }, false)).toBe('<channel source="mailsignal" anzahl="1">1 neue Mail</channel>');
    expect(signalText({ anzahl: 0, gesendet: 1 }, false)).toBe('<channel source="mailsignal" anzahl="0" gesendet="1">1 Mail gesendet</channel>');
    expect(signalText({ anzahl: 0, gesendet: 0, unbekannt: true }, false)).toBe('<channel source="mailsignal" unbekannt="1">neue Mail, Anzahl unbekannt</channel>');
    expect(signalText({ anzahl: 2, gesendet: 0, unbekannt: true }, false)).toBe('<channel source="mailsignal" anzahl="2" unbekannt="1">2 neue Mails, dazu neue Mails ohne Zahl</channel>');
    expect(signalText({ anzahl: 4, gesendet: 2 }, true)).toBe('<channel source="mailsignal" anzahl="4" gesendet="2" gesammelt="1">4 neue Mails, 2 gesendet (gesammelt bei zugeklapptem Laptop)</channel>');
  });

  test('jeder Text passt auf den Rahmen roh und bleibt unter 700 Zeichen', () => {
    for (const t of [signalText({ anzahl: 99999, gesendet: 99999, unbekannt: true }, true), signalText({ anzahl: 0, gesendet: 0, unbekannt: true }, false), nachholText(1), nachholText(12)]) {
      expect(RAHMEN.test(t)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(700);
    }
  });
});

describe('mailsignal-puffer.json', () => {
  test('bei zugeklapptem Laptop gepuffert, ein Neustart liefert als gesammelt nach', () => {
    const datei = join(neuerOrdner(), 'mailsignal-puffer.json');
    const zugestellt: string[] = [];
    const zu = new MailSignal({ pufferDatei: datei, zugeklappt: () => true, zustellen: (t) => (zugestellt.push(t), true) });
    zu.melde({ anzahl: 3, gesendet: 0 });
    zu.melde({ anzahl: 1, gesendet: 2 });
    expect(zugestellt).toEqual([]);
    expect(lies(datei)).toEqual({ anzahl: 4, gesendet: 2, unbekannt: false, gesammelt: true });

    const auf = new MailSignal({ pufferDatei: datei, zugeklappt: () => false, zustellen: (t) => (zugestellt.push(t), true) });
    expect(auf.gepuffert()).toEqual({ anzahl: 4, gesendet: 2, unbekannt: false });
    auf.melde();
    expect(zugestellt).toEqual(['<channel source="mailsignal" anzahl="4" gesendet="2" gesammelt="1">4 neue Mails, 2 gesendet (gesammelt bei zugeklapptem Laptop)</channel>']);
    expect(lies(datei)).toEqual({ anzahl: 0, gesendet: 0, unbekannt: false, gesammelt: false });
  });

  test('abgelehnte Zustellung behält den Puffer, kaputte Datei ergibt einen leeren Puffer', () => {
    const datei = join(neuerOrdner(), 'mailsignal-puffer.json');
    const s = new MailSignal({ pufferDatei: datei, zugeklappt: () => false, zustellen: () => false });
    s.melde({ anzahl: 2, gesendet: 0, unbekannt: true });
    expect(lies(datei)).toEqual({ anzahl: 2, gesendet: 0, unbekannt: true, gesammelt: false });
    writeFileSync(datei, 'kein json');
    expect(new MailSignal({ pufferDatei: datei, zugeklappt: () => false, zustellen: () => true }).gepuffert()).toEqual({ anzahl: 0, gesendet: 0, unbekannt: false });
  });

  test('ohne Zahlen und ohne Puffer wird nichts zugestellt', () => {
    const text: string[] = [];
    new MailSignal({ zugeklappt: () => false, zustellen: (t) => (text.push(t), true) }).melde();
    expect(text).toEqual([]);
  });
});

describe('mailsignal-nachhol.json', () => {
  const TAG = 24 * 60 * 60 * 1000;
  function signal(datei: string, empfaenger: () => string, zu = false) {
    const text: string[] = [];
    return { text, s: new MailSignal({ nachholStand: datei, zugeklappt: () => zu, empfaenger, zustellen: (t) => (text.push(t), true) }) };
  }

  test('Stand mit n, am und an; gleiche Zahl am selben Tag beim selben Empfänger meldet nicht erneut', () => {
    const datei = join(neuerOrdner(), 'mailsignal-nachhol.json');
    const { text, s } = signal(datei, () => 'chef');
    expect(s.meldeAlt(4, 1000)).toBe(true);
    expect(text).toEqual(['<channel source="mailsignal" anzahl="4" alt="1">4 liegengebliebene Mails (älter als 24 h)</channel>']);
    expect(lies(datei)).toEqual({ n: 4, am: 1000, an: 'chef' });
    expect(s.meldeAlt(4, 2000)).toBe(false);
    expect(s.meldeAlt(5, 3000)).toBe(true);
    expect(s.meldeAlt(5, 3000 + TAG)).toBe(true);
  });

  test('ein Neustart liest den Stand, ein Wechsel des Empfängers meldet neu, ein Stand ohne Namen gehört chef', () => {
    const datei = join(neuerOrdner(), 'mailsignal-nachhol.json');
    writeFileSync(datei, JSON.stringify({ n: 2, am: 1000 }));
    expect(signal(datei, () => 'chef').s.meldeAlt(2, 2000)).toBe(false);
    expect(signal(datei, () => 'poststelle').s.meldeAlt(2, 2000)).toBe(true);
  });

  test('n gleich 0, zugeklappter Laptop und Ablehnung lassen den Stand unberührt', () => {
    const datei = join(neuerOrdner(), 'mailsignal-nachhol.json');
    expect(signal(datei, () => 'chef').s.meldeAlt(0, 1000)).toBe(false);
    expect(signal(datei, () => 'chef', true).s.meldeAlt(3, 1000)).toBe(false);
    const ab = new MailSignal({ nachholStand: datei, zugeklappt: () => false, zustellen: () => false });
    expect(ab.meldeAlt(3, 1000)).toBe(false);
    expect(() => readFileSync(datei, 'utf8')).toThrow();
  });

  test('Text des Nachhol-Signals', () => {
    expect(nachholText(1)).toBe('<channel source="mailsignal" anzahl="1" alt="1">1 liegengebliebene Mail (älter als 24 h)</channel>');
  });
});
