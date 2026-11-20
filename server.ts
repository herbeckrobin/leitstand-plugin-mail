import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baueKonten, leseKonten, lesePasswoerter, type ImapFabrik } from './konten.ts';
import { imapFlow } from './imap.ts';
import { sichererName } from './pfade.ts';
import { TRIAGE_DATEI } from './triage.ts';
import { Strukturiert, WerkzeugFehler, type Aufrufer, type Werkzeug } from './typen.ts';
import { imapClient, Waechter, type ImapClient } from './waechter.ts';
import { mailWerkzeuge } from './werkzeuge.ts';

// stdio-MCP-Server des Plugins: JSON-RPC, eine Nachricht je Zeile, ohne SDK. Zusätzlich hält er den Postfach-Wächter
// (dauer: true) und meldet neue Mails als Notification `notifications/leitstand/ereignis` mit der Art `mail.neu` (ADR 0042).
// Die Art (lesen, schreiben) und die Stufe stehen in der plugin.yml, nicht hier: was dieser Prozess über sich sagt, zählt nicht.
// Der Text einer Meldung enthält nur Kontoname und Zahlen, nie Betreff, Adresse oder Inhalt.

const PROTOKOLL = '2025-03-26';
const VERSION = '1.2.0';

/** Zahlen des Ereignisses mail.neu, Form wie im Vertrag mit dem Kern (mailNeuDaten). */
export interface MailNeuDaten {
  konto: string;
  neu: number;
  gesendet: number;
}
const WER: Aufrufer = { session: 'plugin-mail' };

type Json = Record<string, unknown>;

/** Das Gateway stellt `<plugin>_` voran, die Namen im Plugin sind darum ohne das Präfix mail_. */
export const lokaleWerkzeuge = (w: Werkzeug[]): Werkzeug[] => w.map((x) => ({ ...x, name: x.name.replace(/^mail_/, '') }));

/** Antwort auf eine Anfrage, null bei einer Benachrichtigung (ohne id). */
export async function verarbeite(defs: Werkzeug[], msg: Json): Promise<Json | null> {
  const id = msg.id;
  const antwort = (ergebnis: Json): Json => ({ jsonrpc: '2.0', id, result: ergebnis });
  const fehler = (code: number, text: string): Json => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (id === undefined || id === null) return null;
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Json;
  switch (msg.method) {
    case 'initialize':
      return antwort({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOKOLL, capabilities: { tools: {} }, serverInfo: { name: 'mail', version: VERSION } });
    case 'ping':
      return antwort({});
    case 'tools/list':
      return antwort({ tools: defs.map((d) => ({ name: d.name, description: d.beschreibung, inputSchema: { ...d.schema, additionalProperties: false }, annotations: { readOnlyHint: d.nurLesen === true } })) });
    case 'tools/call': {
      const d = defs.find((x) => x.name === params.name);
      if (!d) return fehler(-32602, `Unbekanntes Werkzeug: ${String(params.name).slice(0, 60)}`);
      const a = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      const bekannt = (d.schema.properties ?? {}) as Json;
      const fremd = Object.keys(a).filter((k) => !(k in bekannt));
      try {
        if (fremd.length) throw new WerkzeugFehler(`unbekanntes Argument: ${fremd.slice(0, 3).join(', ')}`);
        const r = await d.aufruf(a, WER);
        if (r instanceof Strukturiert) return antwort({ content: [{ type: 'text', text: JSON.stringify(r.text) }], structuredContent: r.struktur });
        return antwort({ content: [{ type: 'text', text: JSON.stringify(r) }] });
      } catch (e) {
        const text = e instanceof WerkzeugFehler ? e.message : `Interner Fehler: ${e instanceof Error ? e.message.slice(0, 200) : 'unbekannt'}`;
        return antwort({ isError: true, content: [{ type: 'text', text }] });
      }
    }
    default:
      return fehler(-32601, 'Methode unbekannt');
  }
}

export interface WaechterStart {
  env: Record<string, string | undefined>;
  /** Ordner für UIDNEXT-Stand und Triage-Merkliste. */
  daten: string;
  /** Schreibt die Notification an den Leitstand: art, Text für Menschen und die Zahlen als daten. */
  melde: (art: string, text: string, daten: MailNeuDaten) => void;
  log: (zeile: string) => void;
  /** Für Tests: der IMAP-Client je Konto. */
  client?: (z: { host: string; port: number; user: string; pass: string }) => ImapClient;
  sentMs?: number;
  backoffMinMs?: number;
}

/** Ein Wächter je Konto mit Passwort. Fehlt eine Einstellung oder ein Passwort, steht eine Logzeile da und der Prozess läuft ohne Wächter weiter. */
export function starteWaechter(o: WaechterStart): Waechter[] {
  const k = leseKonten(o.env);
  if (!k.ok) {
    o.log(`Wächter aus: ${k.fehler}`);
    return [];
  }
  const p = lesePasswoerter(o.env);
  if (!p.ok) {
    o.log(`Wächter aus: ${p.fehler}`);
    return [];
  }
  const aus: Waechter[] = [];
  for (const c of k.wert) {
    const pass = p.wert[c.name];
    if (!pass) {
      o.log(`Wächter ${c.name} aus: kein Passwort`);
      continue;
    }
    const w = new Waechter({
      neuerClient: () => (o.client ?? imapClient)({ host: c.host, port: c.port, user: c.benutzer, pass }),
      melde: ({ anzahl, gesendet }) => {
        const daten: MailNeuDaten = { konto: c.name, neu: anzahl, gesendet };
        if (anzahl > 0) o.melde('mail.neu', `${c.name}: ${anzahl} neu${gesendet > 0 ? `, ${gesendet} gesendet` : ''}`, daten);
        else o.melde('mail.neu', `${c.name}: ${gesendet} gesendet`, daten);
      },
      zustand: (z) => o.log(`Wächter ${c.name}: ${z.art}, ${z.text}`),
      standDatei: join(o.daten, `stand-${sichererName(c.name)}.json`),
      sentMs: o.sentMs,
      backoffMinMs: o.backoffMinMs,
    });
    w.start();
    aus.push(w);
  }
  o.log(`Wächter: ${aus.length} von ${k.wert.length} Konten`);
  return aus;
}

if (import.meta.main) {
  const daten = join(process.cwd(), 'daten');
  const log = (z: string): void => void process.stderr.write(`${new Date().toISOString()} ${z}\n`);
  const schreibe = (j: Json): void => void process.stdout.write(`${JSON.stringify(j)}\n`);
  const fabrik: ImapFabrik = imapFlow;
  const defs = lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten(process.env, fabrik), triageDatei: () => (mkdirSync(daten, { recursive: true }), join(daten, TRIAGE_DATEI)) }));
  const waechter = starteWaechter({ env: process.env, daten, log, melde: (art, text, daten) => schreibe({ jsonrpc: '2.0', method: 'notifications/leitstand/ereignis', params: { art, text, daten } }) });
  let rest = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    rest += chunk;
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const zeile = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (!zeile) continue;
      let msg: Json;
      try {
        msg = JSON.parse(zeile) as Json;
      } catch {
        schreibe({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Kein JSON' } });
        continue;
      }
      void verarbeite(defs, msg).then((a) => a && schreibe(a));
    }
  });
  process.stdin.on('end', () => void Promise.all(waechter.map((w) => w.stop())).finally(() => process.exit(0)));
}
