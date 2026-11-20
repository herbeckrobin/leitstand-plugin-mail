import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapLike, ImapNachricht, ImapSuche } from '../imap.ts';
import { baueKonten, leseKonten, lesePasswoerter } from '../konten.ts';
import { lokaleWerkzeuge, starteWaechter, verarbeite } from '../server.ts';
import type { ImapClient } from '../waechter.ts';
import { mailWerkzeuge } from '../werkzeuge.ts';

const wurzel = mkdtempSync(join(tmpdir(), 'mail-plugin-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));

const warte = async (bis: () => boolean, ms = 2000): Promise<void> => {
  const t = Date.now();
  while (!bis() && Date.now() - t < ms) await Bun.sleep(5);
  if (!bis()) throw new Error('Zeitüberschreitung im Test');
};

/** IMAP-Test-Doppel für den Wächter: UIDNEXT und UIDVALIDITY je Ordner einstellbar, `exists` auslösbar. */
class WaechterDoppel implements ImapClient {
  usable = true;
  uidNext: Record<string, number> = { INBOX: 5, Gesendet: 3 };
  uidValidity = 1;
  ordner = [{ path: 'INBOX' }, { path: 'Gesendet', specialUse: '\\Sent' }];
  private handler: Record<string, (() => void)[]> = {};
  async connect() {}
  async list() {
    return this.ordner;
  }
  async mailboxOpen() {}
  async status(pfad: string) {
    return { uidNext: this.uidNext[pfad], uidValidity: this.uidValidity };
  }
  on(e: 'exists' | 'close' | 'error', f: (...a: unknown[]) => void) {
    (this.handler[e] ??= []).push(f);
  }
  ausloesen(e: string) {
    for (const f of this.handler[e] ?? []) f();
  }
  async logout() {
    this.usable = false;
  }
}

const KONTEN = JSON.stringify([{ name: 'privat', host: 'imap.example.test', benutzer: 'robin@example.test' }]);
const PASS = JSON.stringify({ privat: 'geheim-pw-123' });

let daten: string;
let nr = 0;
beforeEach(() => {
  daten = join(wurzel, `daten-${++nr}`);
});

const starte = (env: Record<string, string | undefined>, d: WaechterDoppel) => {
  const meldungen: { art: string; text: string }[] = [];
  const logs: string[] = [];
  const w = starteWaechter({ env, daten, melde: (art, text) => meldungen.push({ art, text }), log: (z) => logs.push(z), client: () => d, sentMs: 3600_000, backoffMinMs: 5 });
  return { w, meldungen, logs };
};

describe('Wächter und Ereignis mail.neu', () => {
  test('neue Mail im Posteingang wird als mail.neu gemeldet, nur mit Kontoname und Zahl', async () => {
    const d = new WaechterDoppel();
    const { w, meldungen, logs } = starte({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS }, d);
    await warte(() => logs.some((z) => z.includes('verbunden')));
    expect(meldungen).toEqual([]);
    d.uidNext.INBOX = 7;
    d.ausloesen('exists');
    await warte(() => meldungen.length === 1);
    expect(meldungen[0]).toEqual({ art: 'mail.neu', text: 'privat: 2 neu' });
    expect(JSON.stringify([meldungen, logs])).not.toContain('geheim-pw-123');
    await Promise.all(w.map((x) => x.stop()));
  });

  test('Lücke nach einem Neustart zählt genau einmal (Stand aus daten/)', async () => {
    mkdirSync(daten, { recursive: true });
    writeFileSync(join(daten, 'stand-privat.json'), JSON.stringify({ INBOX: { uidNext: 2, uidValidity: '1' }, Gesendet: { uidNext: 3, uidValidity: '1' } }));
    const d = new WaechterDoppel();
    const { w, meldungen } = starte({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS }, d);
    await warte(() => meldungen.length === 1);
    expect(meldungen[0]!.text).toBe('privat: 3 neu');
    await Bun.sleep(30);
    expect(meldungen.length).toBe(1);
    await Promise.all(w.map((x) => x.stop()));
  });

  test('geänderte UIDVALIDITY setzt eine Basis ohne Zählung', async () => {
    mkdirSync(daten, { recursive: true });
    writeFileSync(join(daten, 'stand-privat.json'), JSON.stringify({ INBOX: { uidNext: 1, uidValidity: '99' } }));
    const d = new WaechterDoppel();
    const { w, meldungen, logs } = starte({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS }, d);
    await warte(() => logs.some((z) => z.includes('UIDVALIDITY')));
    await Bun.sleep(30);
    expect(meldungen).toEqual([]);
    await Promise.all(w.map((x) => x.stop()));
  });

  test('Ausfalltest: ohne Passwörter eine Logzeile, kein Wächter, kein Absturz', () => {
    const { w, logs } = starte({ PLUGIN_KONTEN: KONTEN }, new WaechterDoppel());
    expect(w).toEqual([]);
    expect(logs).toEqual(['Wächter aus: Einstellung passwoerter fehlt']);
  });

  test('Ausfalltest: Konto ohne Passwort wird übersprungen, die anderen laufen', async () => {
    const konten = JSON.stringify([
      { name: 'privat', host: 'h', benutzer: 'a' },
      { name: 'firma', host: 'h', benutzer: 'b' },
    ]);
    const { w, logs } = starte({ PLUGIN_KONTEN: konten, PLUGIN_PASSWOERTER: PASS }, new WaechterDoppel());
    expect(w.length).toBe(1);
    expect(logs.some((z) => z.includes('firma aus: kein Passwort'))).toBe(true);
    await Promise.all(w.map((x) => x.stop()));
  });

  test('Ausfalltest: Server nicht erreichbar, der Wächter versucht es mit Backoff und stürzt nicht', async () => {
    const d = new WaechterDoppel();
    d.connect = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { w, logs } = starte({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS }, d);
    await warte(() => logs.filter((z) => z.includes('warte')).length >= 2);
    await Promise.all(w.map((x) => x.stop()));
  });
});

describe('Einstellungen', () => {
  test('ein Parsefehler in passwoerter gibt das Passwort nicht aus', () => {
    const r = lesePasswoerter({ PLUGIN_PASSWOERTER: '{"privat":"geheim-pw-123' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('geheim');
  });

  test('ein Parsefehler in konten nennt den Rohtext nicht', () => {
    const r = leseKonten({ PLUGIN_KONTEN: '[{"name":"x" geheim' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('geheim');
  });

  test('konten prüft Pflichtfelder, Port und doppelte Namen', () => {
    expect(leseKonten({ PLUGIN_KONTEN: '[{"name":"a"}]' }).ok).toBe(false);
    expect(leseKonten({ PLUGIN_KONTEN: '[{"name":"a","host":"h","benutzer":"u","port":0}]' }).ok).toBe(false);
    expect(leseKonten({ PLUGIN_KONTEN: '[{"name":"a","host":"h","benutzer":"u"},{"name":"a","host":"h","benutzer":"u"}]' }).ok).toBe(false);
    const r = leseKonten({ PLUGIN_KONTEN: '[{"name":"a","host":"h","benutzer":"u","loeschen":"papierkorb"}]' });
    expect(r.ok && r.wert[0]).toMatchObject({ port: 993, adresse: 'u', anzeigename: 'a', loeschen: 'papierkorb' });
  });

  test('ein Konto ohne Passwort ist nicht bereit und nennt keinen Wert', () => {
    const k = baueKonten({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: '{}' });
    expect(k[0]!.nichtBereit?.()).toBe('Kein Passwort für Konto privat in der Einstellung passwoerter');
  });
});

/** IMAP-Test-Doppel für die Werkzeuge. */
class WerkzeugDoppel implements ImapLike {
  usable = true;
  angehaengt: { pfad: string; roh: string; flags: string[] }[] = [];
  async connect() {}
  async logout() {
    this.usable = false;
  }
  async list() {
    return [{ path: 'INBOX' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Trash', specialUse: '\\Trash' }];
  }
  async getMailboxLock() {
    return { release() {} };
  }
  async search(_q: ImapSuche) {
    return [1, 2];
  }
  async *fetch(): AsyncIterable<ImapNachricht> {
    yield { uid: 1, envelope: { subject: 'Eins', from: [{ name: 'A', address: 'a@example.test' }] }, flags: new Set(['\\Seen']) };
    yield { uid: 2, envelope: { subject: 'Zwei', messageId: '<zwei@example.test>', inReplyTo: '<eins@example.test>', from: [{ address: 'b@example.test' }], to: [{ name: 'C', address: 'c@example.test' }], date: new Date('2026-11-20T10:00:00Z') }, flags: new Set<string>(['\\Draft']), headers: Buffer.from('References: <alt@example.test>\r\n <eins@example.test>\r\n') };
  }
  async fetchOne() {
    return false as const;
  }
  async append(pfad: string, inhalt: Buffer, flags: string[]) {
    this.angehaengt.push({ pfad, roh: inhalt.toString('utf8'), flags });
    return { uid: 9 };
  }
  async messageDelete() {
    return true;
  }
  async messageMove() {
    return {};
  }
}

describe('Protokoll und Werkzeuge', () => {
  const doppel = new WerkzeugDoppel();
  const env = { PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: PASS };
  const defs = () => lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten(env, () => doppel), triageDatei: () => join(wurzel, 'triage.json') }));
  const rufe = async (name: string, a: Record<string, unknown>) => {
    const r = await verarbeite(defs(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } });
    const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    return { isError: res.isError, text: res.content[0]!.text, struktur: res.structuredContent };
  };

  test('tools/list: Namen ohne Präfix, readOnlyHint nur bei den vier Lesewerkzeugen', async () => {
    const r = await verarbeite(defs(), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (r!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['anhang_speichern', 'antwort_entwurf', 'entwurf_aendern', 'entwurf_loeschen', 'entwurf_neu', 'entwuerfe_liste', 'lesen', 'posteingang', 'suchen', 'triage_merke', 'verschieben'].sort());
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual(['entwuerfe_liste', 'lesen', 'posteingang', 'suchen']);
  });

  test('die plugin.yml und tools/list nennen dieselben Werkzeuge', async () => {
    const yml = readFileSync(join(import.meta.dir, '..', 'plugin.yml'), 'utf8');
    // Nur der Block werkzeuge: (bis rechte:), sonst zählt rechte.lesen als Werkzeug lesen.
    const block = yml.slice(yml.indexOf('\nwerkzeuge:'), yml.indexOf('\nrechte:'));
    const imYml = [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]!);
    expect(imYml.sort()).toEqual(defs().map((d) => d.name).sort());
  });

  test('posteingang liefert die Mails aus dem Doppel', async () => {
    const r = await rufe('posteingang', {});
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Zwei');
    expect(r.text).toContain('b@example.test');
  });

  test('posteingang, suchen und entwuerfe_liste liefern zusätzlich structuredContent, der Text bleibt', async () => {
    for (const [name, a] of [['posteingang', {}], ['suchen', { von: 'b' }], ['entwuerfe_liste', {}]] as const) {
      const r = await rufe(name, a);
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.text).konto).toBe('privat');
      const mails = r.struktur!.mails as Record<string, unknown>[];
      expect(mails.map((m) => m.uid)).toEqual([2, 1]);
      expect(r.struktur!.konto).toBe('privat');
      expect(mails[0]).toEqual({
        konto: 'privat',
        ordner: name === 'entwuerfe_liste' ? 'Drafts' : 'INBOX',
        uid: 2,
        message_id: '<zwei@example.test>',
        betreff: 'Zwei',
        von: [{ name: null, adresse: 'b@example.test' }],
        an: [{ name: 'C', adresse: 'c@example.test' }],
        cc: [],
        datum: '2026-11-20T10:00:00.000Z',
        flags: ['\\Draft'],
        in_reply_to: '<eins@example.test>',
        references: ['<alt@example.test>', '<eins@example.test>'],
      });
      expect(mails[1]).toMatchObject({ uid: 1, message_id: null, in_reply_to: null, references: [], flags: ['\\Seen'] });
    }
    expect((await rufe('posteingang', {})).text).toContain('"ungelesen":true');
  });

  test('Werkzeuge ohne Liste liefern kein structuredContent', async () => {
    expect((await rufe('triage_merke', { message_id: '<x@y>', gate: 'klar', aktion: 'archiviert' })).struktur).toBeUndefined();
  });

  test('plugin.yml führt die Rollenregel, und die Datei liegt im Plugin', () => {
    const yml = readFileSync(join(import.meta.dir, '..', 'plugin.yml'), 'utf8');
    expect(yml).toMatch(/^rules: \[rules\/mail\.md\]$/m);
    expect(readFileSync(join(import.meta.dir, '..', 'rules', 'mail.md'), 'utf8').length).toBeGreaterThan(500);
  });

  test('unbekanntes Argument und unbekanntes Werkzeug werden abgelehnt', async () => {
    const r = await rufe('posteingang', { sql: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('unbekanntes Argument');
    const u = await verarbeite(defs(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'senden', arguments: {} } });
    expect(u!.error).toBeDefined();
  });

  test('entwurf_neu legt einen Entwurf im Drafts-Ordner an und versendet nichts', async () => {
    const r = await rufe('entwurf_neu', { an: ['x@example.test'], betreff: 'Hallo', text: 'Servus' });
    expect(r.isError).toBeUndefined();
    const a = doppel.angehaengt.at(-1)!;
    expect(a.pfad).toBe('Drafts');
    expect(a.flags).toContain('\\Draft');
    expect(a.roh).toContain('Subject: Hallo');
    expect(a.roh).toContain('X-Leitstand-Entwurf');
  });

  test('ein Konto ohne Passwort scheitert mit klarer Meldung ohne Wert', async () => {
    const d = lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten({ PLUGIN_KONTEN: KONTEN, PLUGIN_PASSWOERTER: '{}' }, () => doppel) }));
    const r = await verarbeite(d, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'posteingang', arguments: {} } });
    const res = r!.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Kein Passwort');
  });

  test('triage_merke schreibt in die Merkliste', async () => {
    const r = await rufe('triage_merke', { message_id: '<ABC@x>', gate: 'klar', aktion: 'archiviert' });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(wurzel, 'triage.json'), 'utf8')).toContain('abc@x');
  });
});

describe('Bundle dist/server.js', () => {
  const bundle = join(import.meta.dir, '..', 'dist', 'server.js');

  test('enthält keinen SMTP-Code', () => {
    const q = readFileSync(bundle, 'utf8');
    expect(q).not.toContain('createTransport');
    expect(q).not.toContain('smtp-connection');
  });

  test('startet über stdio, antwortet auf tools/list und endet mit stdin sauber (Exit 0, ohne Passwörter)', async () => {
    const p = Bun.spawn(['bun', bundle], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', PLUGIN_KONTEN: KONTEN } });
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    p.stdin.end();
    const [aus, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(exit).toBe(0);
    expect(aus).toContain('"posteingang"');
    expect(err).toContain('Wächter aus: Einstellung passwoerter fehlt');
  });
});

describe('Quelltext', () => {
  test('kein Import aus dem Leitstand und kein SMTP-Transport', () => {
    const dir = join(import.meta.dir, '..');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const q = readFileSync(join(dir, f), 'utf8');
      expect(q).not.toMatch(/from '\.\.\/(\.\.\/)?(gateway|domain|quellen|protokoll|pfade)/);
      expect(q).not.toMatch(/from 'nodemailer'/);
      expect(q).not.toMatch(/createTransport/);
    }
  });
});
