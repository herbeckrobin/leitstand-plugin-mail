import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailSignal } from '../signal.ts';
import { istAbgeschickt, leseEingabe, leseUrteile, MailTakt, mailSchluessel, modellPrompt, regelUrteil, taktWerkzeug, triageKarte, TRIAGE_STAND_DATEI, type Aktion, type Mail, type TaktAufgabe } from '../takt.ts';
import { WerkzeugFehler } from '../typen.ts';

const T0 = Date.parse('2026-11-22T12:00:00+01:00');
const mail = (uid: number, von = 'Anna Muster', betreff = 'Frage zur Seite', adresse = 'anna@muster.de'): Mail => ({ konto: 'robin', uid, von, adresse, betreff });
const aufgabe = (o: Partial<TaktAufgabe> = {}): TaktAufgabe => ({ aId: 'A-1', titel: 't', ball: 'Robin', kunde: 'Muster GmbH', projekt: null, faellig: null, offen: true, ...o });

let ordner: string;
beforeEach(() => {
  ordner = mkdtempSync(join(tmpdir(), 'mailtakt-'));
});
afterEach(() => rmSync(ordner, { recursive: true, force: true }));

describe('leseEingabe', () => {
  test('jetzt fehlt oder ist kaputt: WerkzeugFehler', () => {
    expect(() => leseEingabe({})).toThrow(WerkzeugFehler);
    expect(() => leseEingabe({ jetzt: 'gestern' })).toThrow(WerkzeugFehler);
  });
  test('nur jetzt reicht, Felder aus dem Vertrag werden gelesen', () => {
    const e = leseEingabe({
      jetzt: '2026-11-22T12:00:00+01:00',
      klappe: { zu: true, alter_s: 3 },
      karten: [{ id: 'k1', typ: 'review', titel: 'T', entwurf: { konto: 'robin', uuid: 'u', uid: null, art: 'antwort' } }, { id: 'k2', typ: 'info', titel: 'x', entwurf: null }, 5],
      aufgaben: [{ a_id: 'A-1', titel: 't', ball: 'Robin', wartegrund: null, kunde: 'K', projekt: null, faellig: '2026-11-23', offen: true }],
      modell: [{ id: 'm1', ergebnis: 'x' }, { id: 'm2', fehler: 'timeout' }],
    });
    expect(e.jetzt).toBe(T0);
    expect(e.klappeZu).toBe(true);
    expect(e.karten.map((k) => k.entwurf?.uuid ?? null)).toEqual(['u', null]);
    expect(e.aufgaben[0]?.faellig).toBe('2026-11-23');
    expect(e.modell).toEqual([{ id: 'm1', ergebnis: 'x' }, { id: 'm2', fehler: 'timeout' }]);
    expect(leseEingabe({ jetzt: '2026-11-22T12:00:00+01:00' }).karten).toEqual([]);
  });
});

describe('Regel und Modell', () => {
  test('Kunde im Absender mit Ball bei Robin: braucht (muss matchen)', () => {
    expect(regelUrteil(mail(1, 'Muster GmbH Support'), [aufgabe()], T0)).toBe('braucht');
  });
  test('Frist bis morgen zählt, übermorgen nicht', () => {
    const ohneBall = { ball: 'Daniel' };
    expect(regelUrteil(mail(1, 'Muster GmbH'), [aufgabe({ ...ohneBall, faellig: '2026-11-23' })], T0)).toBe('braucht');
    expect(regelUrteil(mail(1, 'Muster GmbH'), [aufgabe({ ...ohneBall, faellig: '2026-11-25' })], T0)).toBeNull();
  });
  test('ohne kunde und projekt in den Aufgaben greift keine Regel', () => {
    expect(regelUrteil(mail(1, 'Muster GmbH'), [aufgabe({ kunde: null })], T0)).toBeNull();
    expect(regelUrteil(mail(1, 'Muster GmbH'), [], T0)).toBeNull();
  });
  test('Teilwort ist kein Treffer', () => {
    expect(regelUrteil(mail(1, 'Mustermann'), [aufgabe({ kunde: 'Muster' })], T0)).toBeNull();
  });
  test('Prompt hat höchstens eine Zeile je Mail, Urteile werden je Nummer gelesen', () => {
    const p = modellPrompt([mail(1), mail(2)]);
    expect(p).toContain('1. Absender');
    expect(p).toContain('2. Absender');
    const u = leseUrteile('Hier: [{"n":1,"braucht":false},{"n":2,"braucht":true},{"n":3,"braucht":"ja"}]');
    expect(u.get(1)).toBe('warten');
    expect(u.get(2)).toBe('braucht');
    expect(u.has(3)).toBe(false);
    expect(leseUrteile('kein json').size).toBe(0);
  });
});

describe('Sammelkarte', () => {
  test('Grenzen des Vertrags: kontext höchstens 10 Zeilen à 300, details höchstens 4000, titel höchstens 200', () => {
    const viele = Array.from({ length: 60 }, (_, i) => ({ mail: mail(i, 'A'.repeat(400), 'B'.repeat(400)), urteil: i % 2 ? ('braucht' as const) : ('warten' as const), grund: 'modell' as const }));
    const a = triageKarte('mail-triage-1', viele, 3);
    if (a.art !== 'karte_neu') throw new Error('falsche Art');
    expect(a.kontext.length).toBeLessThanOrEqual(10);
    for (const z of a.kontext) expect(z.length).toBeLessThanOrEqual(300);
    expect(a.details.length).toBeLessThanOrEqual(4000);
    expect(a.titel.length).toBeLessThanOrEqual(200);
    expect(a.titel.startsWith('Mail-Triage:')).toBe(true);
    expect(a.schluessel).toBe('mail-triage-1');
  });
  test('Rückfall wird als solcher benannt', () => {
    const a = triageKarte('s', [{ mail: mail(1), urteil: 'braucht', grund: 'rueckfall' }], 0);
    if (a.art !== 'karte_neu') throw new Error('falsche Art');
    expect(a.kontext.join('\n')).toContain('ohne Einordnung');
  });
});

describe('Entwurf-Prüfer', () => {
  const kopf = (o: Partial<Parameters<typeof istAbgeschickt>[1]> = {}) => ({ messageId: 'm', inReplyTo: 'r', betreff: 'Re: Hallo', empfaenger: ['a@b.de'], datum: T0, ...o });
  test('Antwort: gleiches In-Reply-To und gemeinsamer Empfänger', () => {
    expect(istAbgeschickt('antwort', kopf(), kopf({ messageId: 'x' }))).toBe(true);
    expect(istAbgeschickt('antwort', kopf(), kopf({ messageId: 'x', inReplyTo: 'anderes' }))).toBe(false);
    expect(istAbgeschickt('antwort', kopf(), kopf({ messageId: 'x', empfaenger: ['c@d.de'] }))).toBe(false);
  });
  test('Gesendetes von vor dem Entwurf zählt nie', () => {
    expect(istAbgeschickt('antwort', kopf(), kopf({ messageId: 'x', datum: T0 - 3600_000 }))).toBe(false);
  });
  test('neue Mail: gleicher Betreff ohne Re:, alle Empfänger enthalten', () => {
    expect(istAbgeschickt('neu', kopf({ betreff: 'Hallo', inReplyTo: null }), kopf({ messageId: 'x', betreff: 'AW: Hallo', inReplyTo: null }))).toBe(true);
    expect(istAbgeschickt('neu', kopf({ betreff: 'Hallo', empfaenger: ['a@b.de', 'c@d.de'] }), kopf({ messageId: 'x', betreff: 'Hallo' }))).toBe(false);
  });
});

/** Takt mit Fake-Werkzeugen. Je Aufruf wird protokolliert, was das Plugin gefragt hat. */
function bau(antworten: Record<string, (args: Record<string, unknown>) => Record<string, unknown>>, opt: { an?: boolean; taktMin?: number } = {}) {
  const zugestellt: string[] = [];
  const klappe = { zu: false };
  const signal = new MailSignal({ pufferDatei: join(ordner, 'p.json'), nachholStand: join(ordner, 'n.json'), zugeklappt: () => klappe.zu, zustellen: (t) => (zugestellt.push(t), true) });
  const log: string[] = [];
  const aufrufe: string[] = [];
  const takt = new MailTakt({
    daten: ordner,
    signal,
    klappe,
    rufe: async (name, args) => {
      aufrufe.push(name);
      const f = antworten[name];
      if (!f) throw new Error(`kein ${name}`);
      return f(args);
    },
    konten: () => ['robin'],
    triage: () => ({ an: opt.an ?? true, taktMin: opt.taktMin ?? 10 }),
    log: (z) => log.push(z),
  });
  return { takt, zugestellt, log, aufrufe, klappe, signal };
}

const neueSeit = (mails: { uid: number; betreff: string; von: { name: string; adresse: string }[] }[], uidNext = 100) => () => ({ konto: 'robin', stand: { uid_next: uidNext, uid_validity: '7' }, mails, ausgelassen: 0 });
const jetzt = (ms: number): string => new Date(ms).toISOString();

describe('Takt-Lauf', () => {
  test('kaputtes jetzt wirft, sonst kommt { aktionen } zurück', async () => {
    const { takt } = bau({}, { an: false });
    await expect(takt.lauf({})).rejects.toThrow(WerkzeugFehler);
    expect((await takt.lauf({ jetzt: jetzt(T0) })).aktionen).toEqual([]);
  });

  test('Triage aus: das Plugin fragt das Postfach nicht', async () => {
    const { takt, aufrufe } = bau({}, { an: false });
    await takt.lauf({ jetzt: jetzt(T0) });
    // Nachholen läuft unabhängig von der Triage, sonst nichts.
    expect(aufrufe.filter((x) => x !== 'nachhol_zaehle')).toEqual([]);
  });

  test('Nachholen: stündlich, nur über das Signal', async () => {
    const { takt, zugestellt } = bau({ nachhol_zaehle: () => ({ anzahl: 3 }) }, { an: false });
    await takt.lauf({ jetzt: jetzt(T0) });
    await new Promise((r) => setTimeout(r, 10));
    expect(zugestellt.length).toBe(1);
    expect(zugestellt[0]).toContain('3 liegengebliebene Mails');
    await takt.lauf({ jetzt: jetzt(T0 + 30_000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(zugestellt.length).toBe(1);
  });

  test('Triage: erster Takt bestellt das Modell, der zweite macht daraus die Sammelkarte', async () => {
    const { takt, log } = bau({ neue_seit: neueSeit([{ uid: 5, betreff: 'Newsletter', von: [{ name: 'Shop', adresse: 's@shop.de' }] }, { uid: 6, betreff: 'Frage', von: [{ name: 'Anna', adresse: 'a@a.de' }] }]) });
    const erst = (await takt.lauf({ jetzt: jetzt(T0) })).aktionen;
    expect(erst.map((a) => a.art)).toEqual(['modell']);
    const m = erst[0] as Extract<Aktion, { art: 'modell' }>;
    expect(m.prompt.length).toBeLessThanOrEqual(8000);
    expect(m.max_zeichen).toBeLessThanOrEqual(4000);
    const zweit = (await takt.lauf({ jetzt: jetzt(T0 + 30_000), modell: [{ id: m.id, ergebnis: '[{"n":1,"braucht":false},{"n":2,"braucht":true}]' }] })).aktionen;
    expect(zweit.map((a) => a.art)).toEqual(['karte_neu']);
    const k = zweit[0] as Extract<Aktion, { art: 'karte_neu' }>;
    expect(k.titel).toContain('1 brauchen dich, 1 können warten');
    // Absender und Betreff stehen nie im Log
    expect(log.join('\n')).not.toContain('Newsletter');
    expect(log.join('\n')).not.toContain('Anna');
    // Der Stand liegt wie im Kern in mailtriage-stand.json
    const stand = JSON.parse(readFileSync(join(ordner, TRIAGE_STAND_DATEI), 'utf8')) as { staende: Record<string, { uidNext: number }> };
    expect(stand.staende.robin?.uidNext).toBe(100);
  });

  test('Modell-Fehler oder kein Ergebnis: Mails zählen als "braucht dich"', async () => {
    const { takt } = bau({ neue_seit: neueSeit([{ uid: 5, betreff: 'x', von: [{ name: 'A', adresse: 'a@a.de' }] }]) });
    const m = ((await takt.lauf({ jetzt: jetzt(T0) })).aktionen[0] as Extract<Aktion, { art: 'modell' }>).id;
    const k = (await takt.lauf({ jetzt: jetzt(T0 + 30_000), modell: [{ id: m, fehler: 'timeout' }] })).aktionen[0] as Extract<Aktion, { art: 'karte_neu' }>;
    expect(k.titel).toContain('1 brauchen dich');
    expect(k.kontext.join('\n')).toContain('ohne Einordnung');
  });

  test('ein Konto mit Fehler hält seinen Stand zurück, die anderen laufen weiter', async () => {
    const { takt, log } = bau({ neue_seit: () => { throw new Error('geheimer Betreff'); } });
    const r = await takt.lauf({ jetzt: jetzt(T0) });
    expect(r.aktionen).toEqual([]);
    expect(log.join('\n')).toContain('fehler=1');
    expect(log.join('\n')).not.toContain('geheimer');
  });

  test('Triage-Takt: ein zweiter Lauf vor Ablauf fragt nicht erneut', async () => {
    const { takt, aufrufe } = bau({ neue_seit: neueSeit([]) }, { taktMin: 10 });
    await takt.lauf({ jetzt: jetzt(T0) });
    await takt.lauf({ jetzt: jetzt(T0 + 30_000) });
    expect(aufrufe.filter((x) => x === 'neue_seit').length).toBe(1);
  });

  test('Klappe zu: das Signal hält zurück, offen liefert es nach', async () => {
    const { takt, zugestellt, signal } = bau({}, { an: false });
    signal.melde({ anzahl: 2, gesendet: 0 });
    expect(zugestellt.length).toBe(1);
    await takt.lauf({ jetzt: jetzt(T0), klappe: { zu: true, alter_s: 1 } });
    signal.melde({ anzahl: 1, gesendet: 0 });
    expect(zugestellt.length).toBe(1);
    await takt.lauf({ jetzt: jetzt(T0 + 30_000), klappe: { zu: false, alter_s: 1 } });
    expect(zugestellt.length).toBe(2);
    expect(zugestellt[1]).toContain('gesammelt');
  });

  test('Entwurf-Prüfer: Gesendetes mit Message-ID erledigt die Review-Karte mit Beleg', async () => {
    const entwurf = { message_id: '<e@x>', in_reply_to: '<r@x>', betreff: 'Re: Hallo', an: [{ adresse: 'a@b.de' }], datum: jetzt(T0), flags: ['\\Draft'] };
    const gesendet = { message_id: '<g@x>', in_reply_to: '<r@x>', betreff: 'Re: Hallo', an: [{ adresse: 'a@b.de' }], datum: jetzt(T0 + 60_000) };
    const { takt } = bau(
      { entwurf_finde: () => ({ gefunden: true, entwurf }), gesendet_finde: () => ({ ordner: 'Sent', mails: [gesendet] }) },
      { an: false },
    );
    const karte = { id: 'k1', typ: 'review', titel: 'Entwurf', entwurf: { konto: 'robin', uuid: 'u-1', uid: null, art: 'antwort' } };
    const r = (await takt.lauf({ jetzt: jetzt(T0 + 120_000), karten: [karte] })).aktionen;
    expect(r).toEqual([{ art: 'karte_erledige', id: 'k1', beleg: '<g@x>' }]);
  });

  test('Entwurf-Prüfer: nichts gesendet oder kein Gesendet-Ordner lässt die Karte offen', async () => {
    const entwurf = { message_id: '<e@x>', in_reply_to: '<r@x>', betreff: 'Re: Hallo', an: [{ adresse: 'a@b.de' }], datum: jetzt(T0), flags: [] };
    const karte = { id: 'k1', typ: 'review', titel: 'Entwurf', entwurf: { konto: 'robin', uuid: 'u-1', uid: null, art: 'antwort' } };
    const leer = bau({ entwurf_finde: () => ({ gefunden: true, entwurf }), gesendet_finde: () => ({ ordner: 'Sent', mails: [] }) }, { an: false });
    expect((await leer.takt.lauf({ jetzt: jetzt(T0), karten: [karte] })).aktionen).toEqual([]);
    const ohne = bau({ entwurf_finde: () => ({ gefunden: true, entwurf }), gesendet_finde: () => ({ ordner: null, mails: [] }) }, { an: false });
    expect((await ohne.takt.lauf({ jetzt: jetzt(T0), karten: [karte] })).aktionen).toEqual([]);
  });

  test('Entwurf-Prüfer: Fehler wird zur Störung, einmal je Ursache, ohne Inhalt', async () => {
    const karte = { id: 'k1', typ: 'review', titel: 'Entwurf', entwurf: { konto: 'robin', uuid: 'u-1', uid: null, art: 'antwort' } };
    const { takt } = bau({ entwurf_finde: () => { throw new Error('Betreff geheim'); } }, { an: false });
    const a = (await takt.lauf({ jetzt: jetzt(T0), karten: [karte] })).aktionen;
    expect(a.length).toBe(1);
    const s = a[0] as Extract<Aktion, { art: 'stoerung' }>;
    expect(s.art).toBe('stoerung');
    expect(s.stelle.startsWith('mail.')).toBe(true);
    expect(s.text).not.toContain('geheim');
    expect((await takt.lauf({ jetzt: jetzt(T0 + 120_000), karten: [karte] })).aktionen).toEqual([]);
  });

  test('höchstens 20 Aktionen und 3 Modell-Aufrufe je Takt', async () => {
    const viele = Array.from({ length: 50 }, (_, i) => ({ uid: i + 1, betreff: `b${i}`, von: [{ name: `N${i}`, adresse: `n${i}@x.de` }] }));
    const { takt } = bau({ neue_seit: neueSeit(viele) });
    const a = (await takt.lauf({ jetzt: jetzt(T0) })).aktionen;
    expect(a.filter((x) => x.art === 'modell').length).toBe(3);
    expect(a.length).toBeLessThanOrEqual(20);
  });

  test('Werkzeug takt antwortet mit dem Objekt { aktionen }', async () => {
    const { takt } = bau({}, { an: false });
    const w = taktWerkzeug(takt);
    expect(w.name).toBe('takt');
    expect(await w.aufruf({ jetzt: jetzt(T0) }, { session: 'x' })).toEqual({ aktionen: [] });
  });

  test('kaputte Stand-Datei: Basis neu, kein Absturz', async () => {
    writeFileSync(join(ordner, TRIAGE_STAND_DATEI), '{kaputt');
    const { takt } = bau({ neue_seit: neueSeit([]) });
    expect((await takt.lauf({ jetzt: jetzt(T0) })).aktionen).toEqual([]);
  });

  test('mailSchluessel trennt Konten', () => {
    expect(mailSchluessel({ konto: 'a', uid: 1 })).not.toBe(mailSchluessel({ konto: 'b', uid: 1 }));
  });
});
