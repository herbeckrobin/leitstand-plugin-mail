import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapLike, ImapNachricht, ImapSuche } from '../imap.ts';
import { baueKonten } from '../konten.ts';
import { lokaleWerkzeuge, verarbeite } from '../server.ts';
import { merkeTriage } from '../triage.ts';
import { mailWerkzeuge, ohneRe } from '../werkzeuge.ts';

// Werkzeuge für den Kern gegen eine IMAP-Attrappe, kein echtes Konto. Die Form der Antworten wird gegen eine Kopie der
// Zod-Schemas aus dem Vertrag des Kerns (server/mail-plugin.ts, Commit 73d67c07) als Formbeschreibung geprüft: gleiche
// Schlüssel, gleiche Typen, nichts Zusätzliches. Das Plugin hängt bewusst nicht von zod ab.

const wurzel = mkdtempSync(join(tmpdir(), 'mail-kern-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));

// ---- Formprüfung ----
type Form = 'str' | 'strNull' | 'bool' | 'int' | 'intPos' | 'intNull' | 'iso' | { arr: Form } | { obj: Record<string, Form> } | { oder: Form[] };
const arr = (f: Form): Form => ({ arr: f });
const obj = (o: Record<string, Form>): Form => ({ obj: o });
const nullOr = (f: Form): Form => ({ oder: ['null' as never, f] });

function fehler(f: Form | 'null', v: unknown, pfad: string): string | null {
  if (f === 'null') return v === null ? null : `${pfad}: erwartet null`;
  if (f === 'str') return typeof v === 'string' ? null : `${pfad}: erwartet Text`;
  if (f === 'strNull' || f === 'iso') return v === null || typeof v === 'string' ? null : `${pfad}: erwartet Text oder null`;
  if (f === 'bool') return typeof v === 'boolean' ? null : `${pfad}: erwartet bool`;
  if (f === 'int') return Number.isInteger(v) && (v as number) >= 0 ? null : `${pfad}: erwartet ganze Zahl >= 0`;
  if (f === 'intPos') return Number.isInteger(v) && (v as number) > 0 ? null : `${pfad}: erwartet ganze Zahl > 0`;
  if (f === 'intNull') return v === null || (Number.isInteger(v) && (v as number) >= 0) ? null : `${pfad}: erwartet Zahl oder null`;
  if ('arr' in f) return Array.isArray(v) ? (v.map((x, i) => fehler(f.arr, x, `${pfad}[${i}]`)).find(Boolean) ?? null) : `${pfad}: erwartet Liste`;
  if ('oder' in f) return f.oder.some((x) => fehler(x, v, pfad) === null) ? null : `${pfad}: passt auf keine Form`;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${pfad}: erwartet Objekt`;
  const keys = Object.keys(v).sort().join(',');
  const soll = Object.keys(f.obj).sort().join(',');
  if (keys !== soll) return `${pfad}: Schlüssel ${keys}, erwartet ${soll}`;
  for (const [k, g] of Object.entries(f.obj)) {
    const e = fehler(g, (v as Record<string, unknown>)[k], `${pfad}.${k}`);
    if (e) return e;
  }
  return null;
}
const passt = (f: Form, v: unknown): void => expect(fehler(f, v, '$')).toBeNull();

const person = obj({ name: 'strNull', adresse: 'str' });
const kopfForm: Record<string, Form> = { uid: 'intPos', message_id: 'strNull', in_reply_to: 'strNull', betreff: 'str', an: arr(person), cc: arr(person), datum: 'iso', flags: arr('str') };
const neueSeitForm = obj({ konto: 'str', stand: obj({ uid_next: 'intPos', uid_validity: 'str' }), mails: arr(obj({ uid: 'intPos', betreff: 'str', von: arr(person) })), ausgelassen: 'int' });
const nachholForm = obj({ anzahl: 'intNull' });
const entwurfForm = obj({
  konto: 'str',
  gefunden: 'bool',
  entwurf: nullOr(obj({ ...kopfForm, inhalt: nullOr(obj({ text: 'str', html: 'strNull', anhaenge: arr(obj({ name: 'strNull', typ: 'str', groesse: 'int', inline: 'bool' })) })) })),
});
const gesendetForm = obj({ konto: 'str', ordner: 'strNull', mails: arr(obj(kopfForm)) });
const pruefForm = obj({ konten: arr(obj({ konto: 'str', ok: 'bool', fehler: 'strNull', ordner: obj({ entwuerfe: 'strNull', gesendet: 'strNull', papierkorb: 'strNull' }) })) });

test('die Formprüfung schlägt an: fehlendes Feld, falscher Typ, Zusatzfeld', () => {
  expect(fehler(nachholForm, {}, '$')).not.toBeNull();
  expect(fehler(nachholForm, { anzahl: 'x' }, '$')).not.toBeNull();
  expect(fehler(nachholForm, { anzahl: 1, extra: 1 }, '$')).not.toBeNull();
  expect(fehler(nachholForm, { anzahl: null }, '$')).toBeNull();
});

// ---- IMAP-Attrappe ----
interface Box {
  specialUse?: string;
  uidNext: number;
  uidValidity: number;
  mails: (ImapNachricht & { kopf?: Record<string, string> })[];
}

class KernDoppel implements ImapLike {
  usable = true;
  offen = '';
  verbindungen = 0;
  constructor(
    public boxen: Record<string, Box>,
    private connectFehler: Error | null = null,
  ) {}
  async connect() {
    this.verbindungen++;
    if (this.connectFehler) throw this.connectFehler;
  }
  async logout() {
    this.usable = false;
  }
  async list() {
    return Object.entries(this.boxen).map(([path, b]) => ({ path, specialUse: b.specialUse }));
  }
  async status(path: string) {
    const b = this.boxen[path]!;
    return { uidNext: b.uidNext, uidValidity: b.uidValidity };
  }
  async getMailboxLock(path: string) {
    this.offen = path;
    return { release() {} };
  }
  async search(q: ImapSuche) {
    const b = this.boxen[this.offen]!;
    return b.mails
      .filter((m) => {
        if (q.subject && !(m.envelope?.subject ?? '').toLowerCase().includes(q.subject.toLowerCase())) return false;
        if (q.since && new Date(m.internalDate ?? 0).getTime() < q.since.getTime()) return false;
        if (q.before && new Date(m.internalDate ?? 0).getTime() >= q.before.getTime()) return false;
        for (const [k, v] of Object.entries(q.header ?? {})) if (m.kopf?.[k.toLowerCase()] !== v) return false;
        return true;
      })
      .map((m) => m.uid);
  }
  async *fetch(range: number[] | string): AsyncIterable<ImapNachricht> {
    const b = this.boxen[this.offen]!;
    let treffer: ImapNachricht[];
    if (typeof range === 'string') {
      const von = Number(range.split(':')[0]);
      treffer = b.mails.filter((m) => m.uid >= von);
      // wie imapflow/IMAP: n:* liefert mindestens die letzte Mail
      if (!treffer.length && b.mails.length) treffer = [b.mails[b.mails.length - 1]!];
    } else treffer = b.mails.filter((m) => range.includes(m.uid));
    for (const m of treffer) yield m;
  }
  async fetchOne(uid: string, q: Record<string, boolean>) {
    const m = this.boxen[this.offen]!.mails.find((x) => x.uid === Number(uid));
    if (!m) return false as const;
    return q.source ? m : { ...m, source: undefined };
  }
  async append() {
    return false as const;
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

const mail = (uid: number, betreff: string, extra: Partial<ImapNachricht> & { kopf?: Record<string, string> } = {}) => ({
  uid,
  envelope: { subject: betreff, from: [{ name: 'Absender', address: `a${uid}@example.test` }] },
  flags: new Set<string>(),
  internalDate: new Date('2026-11-20T10:00:00Z'),
  ...extra,
});

function werkzeug(doppel: KernDoppel | ((n: number) => KernDoppel), umgebung: Record<string, string | undefined> = env, triage?: string) {
  let n = 0;
  const fabrik = () => (typeof doppel === 'function' ? doppel(n++) : doppel);
  const defs = lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten(umgebung, fabrik), triageDatei: triage ? () => triage : undefined }));
  return async (name: string, a: Record<string, unknown> = {}) => {
    const r = await verarbeite(defs, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } });
    const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    return { isError: res.isError === true, text: res.content[0]!.text, struktur: res.structuredContent };
  };
}

const inbox = (mails: Box['mails'], uidNext: number, uidValidity = 1): Record<string, Box> => ({ INBOX: { uidNext, uidValidity, mails } });

// ---- neue_seit ----
describe('neue_seit', () => {
  test('Treffer: nur Mails ab uid_next, aufsteigend, der Stand rückt auf UIDNEXT', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([1, 2, 3, 4, 5, 6].map((u) => mail(u, `Betreff ${u}`)), 7)));
    const r = await rufe('neue_seit', { konto: 'privat', uid_next: 3, uid_validity: '1' });
    expect(r.isError).toBe(false);
    passt(neueSeitForm, r.struktur);
    const s = r.struktur as { stand: object; mails: { uid: number; von: unknown }[]; ausgelassen: number };
    expect(s.mails.map((m) => m.uid)).toEqual([3, 4, 5, 6]);
    expect(s.mails[0]!.von).toEqual([{ name: 'Absender', adresse: 'a3@example.test' }]);
    expect(s.stand).toEqual({ uid_next: 7, uid_validity: '1' });
    expect(s.ausgelassen).toBe(0);
    expect(r.text).not.toContain('Betreff');
  });

  test('Leer: ohne Stand ist der heutige Stand die Basis, mails bleibt leer', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([mail(1, 'Alt')], 2)));
    const r = await rufe('neue_seit', { konto: 'privat' });
    passt(neueSeitForm, r.struktur);
    expect(r.struktur).toEqual({ konto: 'privat', stand: { uid_next: 2, uid_validity: '1' }, mails: [], ausgelassen: 0 });
  });

  test('Leer: geänderte uid_validity setzt eine neue Basis ohne Mails', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([mail(1, 'A'), mail(2, 'B')], 3, 7)));
    const r = await rufe('neue_seit', { konto: 'privat', uid_next: 1, uid_validity: '1' });
    passt(neueSeitForm, r.struktur);
    expect(r.struktur).toMatchObject({ stand: { uid_next: 3, uid_validity: '7' }, mails: [], ausgelassen: 0 });
  });

  test('Leer: nichts Neues lässt den Stand stehen und holt die letzte Mail nicht fälschlich', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([mail(1, 'A'), mail(2, 'B')], 3)));
    const r = await rufe('neue_seit', { konto: 'privat', uid_next: 3, uid_validity: '1' });
    expect(r.struktur).toMatchObject({ stand: { uid_next: 3, uid_validity: '1' }, mails: [], ausgelassen: 0 });
  });

  test('Grenze: höchstens 50 Mails (die neuesten), der Rest zählt als ausgelassen', async () => {
    const alle = Array.from({ length: 60 }, (_, i) => mail(i + 1, `M${i + 1}`));
    const rufe = werkzeug(new KernDoppel(inbox(alle, 61)));
    const r = await rufe('neue_seit', { konto: 'privat', uid_next: 1, uid_validity: '1' });
    passt(neueSeitForm, r.struktur);
    const s = r.struktur as { mails: { uid: number }[]; ausgelassen: number };
    expect(s.mails.length).toBe(50);
    expect(s.mails[0]!.uid).toBe(11);
    expect(s.mails.at(-1)!.uid).toBe(60);
    expect(s.ausgelassen).toBe(10);
  });

  test('Fehler: ohne konto und mit unbekanntem Konto', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([], 1)));
    expect((await rufe('neue_seit', { konto: 'gibtsnicht' })).isError).toBe(true);
    expect((await rufe('neue_seit', { konto: 'privat', uid_next: 0, uid_validity: '1' })).isError).toBe(true);
  });
});

// ---- nachhol_zaehle ----
describe('nachhol_zaehle', () => {
  const alt = (uid: number, id: string) => mail(uid, 'Alt', { internalDate: new Date(Date.now() - 3 * 86_400_000), envelope: { subject: 'Alt', messageId: id } });
  const neu = mail(9, 'Neu', { internalDate: new Date(), envelope: { subject: 'Neu', messageId: '<neu@x>' } });

  test('Treffer: zählt Mails über 24 h ohne Entscheidung oder mit unklar, nicht die klaren und nicht die neuen', async () => {
    const triage = join(wurzel, 'triage-a.json');
    merkeTriage(triage, 'klar@x', { gate: 'klar', aktion: 'archiviert' });
    merkeTriage(triage, 'unklar@x', { gate: 'unklar', aktion: 'offen' });
    const rufe = werkzeug(new KernDoppel(inbox([alt(1, '<ohne@x>'), alt(2, '<klar@x>'), alt(3, '<unklar@x>'), neu], 10)), env, triage);
    const r = await rufe('nachhol_zaehle');
    expect(r.isError).toBe(false);
    passt(nachholForm, r.struktur);
    expect(r.struktur).toEqual({ anzahl: 2 });
  });

  test('Leer: nichts liegengeblieben ergibt 0, nicht null', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([neu], 10)), env, join(wurzel, 'triage-leer.json'));
    const r = await rufe('nachhol_zaehle');
    passt(nachholForm, r.struktur);
    expect(r.struktur).toEqual({ anzahl: 0 });
  });

  test('Ausfall: ein nicht lesbares Konto macht anzahl zu null', async () => {
    const konten = JSON.stringify([
      { name: 'privat', host: 'h', benutzer: 'a' },
      { name: 'firma', host: 'h', benutzer: 'b' },
    ]);
    const pass = JSON.stringify({ privat: 'x', firma: 'y' });
    const rufe = werkzeug((n) => new KernDoppel(inbox([alt(1, '<a@x>')], 2), n === 1 ? new Error('ECONNREFUSED') : null), { PLUGIN_KONTEN: konten, PLUGIN_PASSWOERTER: pass }, join(wurzel, 'triage-b.json'));
    const r = await rufe('nachhol_zaehle');
    passt(nachholForm, r.struktur);
    expect(r.struktur).toEqual({ anzahl: null });
  });

  test('Ausfall: ein Konto ohne Passwort macht anzahl zu null', async () => {
    const rufe = werkzeug(new KernDoppel(inbox([], 1)), { PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: '{}' });
    expect((await rufe('nachhol_zaehle')).struktur).toEqual({ anzahl: null });
  });
});

// ---- entwurf_finde ----
const QUELLE = [
  'From: robin@example.test',
  'To: kunde@example.test',
  'Subject: Angebot',
  'Message-ID: <entwurf1@example.test>',
  'X-Universally-Unique-Identifier: UUID-1',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: multipart/alternative; boundary="b2"',
  '',
  '--b2',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hallo Text',
  '--b2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hallo Text</p>',
  '--b2--',
  '--b1',
  'Content-Type: application/pdf; name="angebot.pdf"',
  'Content-Disposition: attachment; filename="angebot.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'SGFsbG8=',
  '--b1--',
  '',
].join('\r\n');

describe('entwurf_finde', () => {
  const entwuerfe = (): Record<string, Box> => ({
    INBOX: { uidNext: 1, uidValidity: 1, mails: [] },
    Drafts: {
      specialUse: '\\Drafts',
      uidNext: 6,
      uidValidity: 1,
      mails: [
        mail(5, 'Angebot', {
          envelope: { subject: 'Angebot', messageId: '<entwurf1@example.test>', inReplyTo: '<orig@example.test>', to: [{ name: 'Kunde', address: 'kunde@example.test' }], date: new Date('2026-11-20T09:00:00Z') },
          flags: new Set(['\\Draft', '\\Seen']),
          source: Buffer.from(QUELLE),
          kopf: { 'x-universally-unique-identifier': 'UUID-1' },
        }),
      ],
    },
  });

  test('Treffer über uuid mit Inhalt: Kopf, Text, HTML, Anhangsliste', async () => {
    const rufe = werkzeug(new KernDoppel(entwuerfe()));
    const r = await rufe('entwurf_finde', { konto: 'privat', uuid: 'UUID-1', mit_inhalt: true });
    expect(r.isError).toBe(false);
    passt(entwurfForm, r.struktur);
    const e = (r.struktur as { gefunden: boolean; entwurf: Record<string, unknown> }).entwurf;
    expect(e).toMatchObject({ uid: 5, message_id: '<entwurf1@example.test>', in_reply_to: '<orig@example.test>', betreff: 'Angebot', an: [{ name: 'Kunde', adresse: 'kunde@example.test' }], cc: [], datum: '2026-11-20T09:00:00.000Z', flags: ['\\Draft', '\\Seen'] });
    const inhalt = e.inhalt as { text: string; html: string; anhaenge: unknown[] };
    expect(inhalt.text).toContain('Hallo Text');
    expect(inhalt.html).toContain('<p>Hallo Text</p>');
    expect(inhalt.anhaenge).toEqual([{ name: 'angebot.pdf', typ: 'application/pdf', groesse: 5, inline: false }]);
  });

  test('Treffer über uid ohne mit_inhalt: inhalt ist null', async () => {
    const rufe = werkzeug(new KernDoppel(entwuerfe()));
    const r = await rufe('entwurf_finde', { konto: 'privat', uid: 5 });
    passt(entwurfForm, r.struktur);
    expect((r.struktur as { entwurf: { inhalt: unknown } }).entwurf.inhalt).toBeNull();
  });

  test('Leer: unbekannte uuid und unbekannte uid ergeben gefunden false', async () => {
    const rufe = werkzeug(new KernDoppel(entwuerfe()));
    for (const a of [{ uuid: 'GIBTS-NICHT' }, { uid: 99 }]) {
      const r = await rufe('entwurf_finde', { konto: 'privat', ...a });
      passt(entwurfForm, r.struktur);
      expect(r.struktur).toEqual({ konto: 'privat', gefunden: false, entwurf: null });
    }
  });

  test('Fehler: weder uuid noch uid, und ein Konto ohne Entwürfe-Ordner', async () => {
    const rufe = werkzeug(new KernDoppel(entwuerfe()));
    expect((await rufe('entwurf_finde', { konto: 'privat' })).isError).toBe(true);
    const ohne = werkzeug(new KernDoppel(inbox([], 1)));
    expect((await ohne('entwurf_finde', { konto: 'privat', uid: 1 })).isError).toBe(true);
  });
});

// ---- gesendet_finde ----
describe('gesendet_finde', () => {
  const gesendet = (): Record<string, Box> => ({
    INBOX: { uidNext: 1, uidValidity: 1, mails: [] },
    'Sent Items': {
      specialUse: '\\Sent',
      uidNext: 5,
      uidValidity: 1,
      mails: [
        mail(1, 'Angebot', { internalDate: new Date('2026-11-01T08:00:00Z'), envelope: { subject: 'Angebot', messageId: '<g1@x>', to: [{ address: 'k@example.test' }] } }),
        mail(2, 'Re: Angebot', { internalDate: new Date('2026-11-19T08:00:00Z'), envelope: { subject: 'Re: Angebot', messageId: '<g2@x>', inReplyTo: '<orig@x>', to: [{ address: 'k@example.test' }] }, kopf: { 'in-reply-to': '<orig@x>' } }),
        mail(3, 'Rechnung', { internalDate: new Date('2026-11-20T08:00:00Z'), envelope: { subject: 'Rechnung', messageId: '<g3@x>' }, kopf: { 'x-universally-unique-identifier': 'UUID-9' } }),
      ],
    },
  });

  test('Treffer über in_reply_to', async () => {
    const rufe = werkzeug(new KernDoppel(gesendet()));
    const r = await rufe('gesendet_finde', { konto: 'privat', in_reply_to: '<orig@x>' });
    expect(r.isError).toBe(false);
    passt(gesendetForm, r.struktur);
    const s = r.struktur as { ordner: string; mails: { uid: number; in_reply_to: string }[] };
    expect(s.ordner).toBe('Sent Items');
    expect(s.mails.map((m) => m.uid)).toEqual([2]);
    expect(s.mails[0]!.in_reply_to).toBe('<orig@x>');
  });

  test('Treffer über betreff mit Re:/Aw: im Argument, neueste zuerst; seit_ms schneidet Älteres ab', async () => {
    const rufe = werkzeug(new KernDoppel(gesendet()));
    const alle = await rufe('gesendet_finde', { konto: 'privat', betreff: 'Aw: Re: Angebot' });
    passt(gesendetForm, alle.struktur);
    expect((alle.struktur as { mails: { uid: number }[] }).mails.map((m) => m.uid)).toEqual([2, 1]);
    const neu = await rufe('gesendet_finde', { konto: 'privat', betreff: 'Angebot', seit_ms: new Date('2026-11-10T00:00:00Z').getTime() });
    expect((neu.struktur as { mails: { uid: number }[] }).mails.map((m) => m.uid)).toEqual([2]);
  });

  test('Treffer über uuid', async () => {
    const rufe = werkzeug(new KernDoppel(gesendet()));
    const r = await rufe('gesendet_finde', { konto: 'privat', uuid: 'UUID-9' });
    passt(gesendetForm, r.struktur);
    expect((r.struktur as { mails: { uid: number }[] }).mails.map((m) => m.uid)).toEqual([3]);
  });

  test('Grenze: höchstens 20 Mails, die neuesten', async () => {
    const viele = Array.from({ length: 25 }, (_, i) => mail(i + 1, 'Serie'));
    const rufe = werkzeug(new KernDoppel({ 'Sent Items': { specialUse: '\\Sent', uidNext: 26, uidValidity: 1, mails: viele } }));
    const r = await rufe('gesendet_finde', { konto: 'privat', betreff: 'Serie' });
    const m = (r.struktur as { mails: { uid: number }[] }).mails;
    expect(m.length).toBe(20);
    expect(m[0]!.uid).toBe(25);
  });

  test('Leer: kein Treffer, und ein Konto ohne Gesendet-Ordner liefert ordner null', async () => {
    const rufe = werkzeug(new KernDoppel(gesendet()));
    const r = await rufe('gesendet_finde', { konto: 'privat', betreff: 'Gibtsnicht' });
    passt(gesendetForm, r.struktur);
    expect(r.struktur).toEqual({ konto: 'privat', ordner: 'Sent Items', mails: [] });
    const ohne = werkzeug(new KernDoppel(inbox([], 1)));
    const o = await ohne('gesendet_finde', { konto: 'privat', betreff: 'X' });
    passt(gesendetForm, o.struktur);
    expect(o.struktur).toEqual({ konto: 'privat', ordner: null, mails: [] });
  });

  test('Fehler: genau eine Suchart', async () => {
    const rufe = werkzeug(new KernDoppel(gesendet()));
    expect((await rufe('gesendet_finde', { konto: 'privat' })).isError).toBe(true);
    expect((await rufe('gesendet_finde', { konto: 'privat', betreff: 'A', uuid: 'B' })).isError).toBe(true);
    expect((await rufe('gesendet_finde', { konto: 'privat', betreff: 'Re:' })).isError).toBe(true);
  });

  test('ohneRe entfernt mehrfaches Re: und Aw:', () => {
    expect(ohneRe('AW: Re: aw: Hallo Welt')).toBe('Hallo Welt');
    expect(ohneRe('Hallo')).toBe('Hallo');
  });
});

// ---- konto_pruefe ----
describe('konto_pruefe', () => {
  const ordner = (): Record<string, Box> => ({
    INBOX: { uidNext: 1, uidValidity: 1, mails: [] },
    Drafts: { specialUse: '\\Drafts', uidNext: 1, uidValidity: 1, mails: [] },
    Sent: { specialUse: '\\Sent', uidNext: 1, uidValidity: 1, mails: [] },
    Trash: { specialUse: '\\Trash', uidNext: 1, uidValidity: 1, mails: [] },
  });

  test('Treffer: Login ok, Special-Use-Ordner je Konto', async () => {
    const rufe = werkzeug(new KernDoppel(ordner()));
    const r = await rufe('konto_pruefe');
    expect(r.isError).toBe(false);
    passt(pruefForm, r.struktur);
    expect(r.struktur).toEqual({ konten: [{ konto: 'privat', ok: true, fehler: null, ordner: { entwuerfe: 'Drafts', gesendet: 'Sent', papierkorb: 'Trash' } }] });
  });

  test('Treffer: Konto ohne Papierkorb meldet null für den Ordner', async () => {
    const o = ordner();
    delete o.Trash;
    const r = await werkzeug(new KernDoppel(o))('konto_pruefe', { konto: 'privat' });
    passt(pruefForm, r.struktur);
    expect((r.struktur as { konten: { ordner: { papierkorb: unknown } }[] }).konten[0]!.ordner.papierkorb).toBeNull();
  });

  test('Fehler: abgelehnte Anmeldung nennt weder Passwort noch Serverantwort', async () => {
    const e = Object.assign(new Error('Invalid credentials geheim-pw-123'), { authenticationFailed: true, response: 'NO geheim-pw-123' });
    const r = await werkzeug(new KernDoppel(ordner(), e))('konto_pruefe');
    passt(pruefForm, r.struktur);
    const k = (r.struktur as { konten: { ok: boolean; fehler: string; ordner: unknown }[] }).konten[0]!;
    expect(k.ok).toBe(false);
    expect(k.fehler).toBe('Anmeldung abgelehnt');
    expect(k.ordner).toEqual({ entwuerfe: null, gesendet: null, papierkorb: null });
    expect(JSON.stringify(r)).not.toContain('geheim');
  });

  test('Fehler: Netzfehler nennt nur den Code, ein fremder Text in der Meldung bleibt draußen', async () => {
    const e = Object.assign(new Error('connect failed geheim-pw-123'), { code: 'ECONNREFUSED' });
    const r = await werkzeug(new KernDoppel(ordner(), e))('konto_pruefe');
    const k = (r.struktur as { konten: { fehler: string }[] }).konten[0]!;
    expect(k.fehler).toBe('Verbindung fehlgeschlagen (ECONNREFUSED)');
    expect(JSON.stringify(r)).not.toContain('geheim');
  });

  test('Leer: Konto ohne Passwort ist nicht ok, unbekanntes Konto ist ein Fehler', async () => {
    const rufe = werkzeug(new KernDoppel(ordner()), { PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: '{}' });
    const r = await rufe('konto_pruefe');
    passt(pruefForm, r.struktur);
    expect((r.struktur as { konten: { ok: boolean }[] }).konten[0]!.ok).toBe(false);
    expect((await rufe('konto_pruefe', { konto: 'gibtsnicht' })).isError).toBe(true);
  });

  test('Ohne Konten in den Einstellungen: leere Liste', async () => {
    const r = await werkzeug(new KernDoppel(ordner()), {})('konto_pruefe');
    passt(pruefForm, r.struktur);
    expect(r.struktur).toEqual({ konten: [] });
  });
});
