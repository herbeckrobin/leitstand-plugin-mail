import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baueKonten, leseKonten, lesePasswoerter, type ImapFabrik } from './konten.ts';
import { imapFlow } from './imap.ts';
import { sichererName } from './pfade.ts';
import { textRenderer } from './pdf-text.ts';
import { MailSignal, NACHHOL_DATEI, PUFFER_DATEI } from './signal.ts';
import { MailTakt, taktWerkzeug } from './takt.ts';
import { TRIAGE_DATEI } from './triage.ts';
import { Strukturiert, WerkzeugFehler, type Aufrufer, type Werkzeug } from './typen.ts';
import { imapClient, Waechter, type ImapClient } from './waechter.ts';
import { mailWerkzeuge } from './werkzeuge.ts';

// stdio-MCP-Server des Plugins: JSON-RPC, eine Nachricht je Zeile, ohne SDK. Zusätzlich hält er den Postfach-Wächter
// (dauer: true) und meldet neue Mails als Notification `notifications/leitstand/ereignis` mit der Art `mail.neu` (ADR 0042).
// Die Art (lesen, schreiben) und die Stufe stehen in der plugin.yml, nicht hier: was dieser Prozess über sich sagt, zählt nicht.
// Der Text einer Meldung enthält nur Kontoname und Zahlen, nie Betreff, Adresse oder Inhalt.

const PROTOKOLL = '2025-03-26';
const VERSION = '1.5.1';

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
  /** Mit Signal geht jede Zahl des Wächters durch den Puffer und kommt als Ereignis mit fertigem Text (roh) an, ohne bleibt es bei melde. */
  signal?: MailSignal;
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
        if (o.signal) {
          o.signal.melde({ anzahl, gesendet });
          return;
        }
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

/**
 * Der Datenordner kommt allein vom Kern (PLUGIN_DATEN, A-2313). Die eigene Kopie darf nie beschrieben werden: die Baumprüfung
 * sperrt den Start, sobald dort eine Datei dazukommt (Störung 127). Darum kein Rückfall auf cwd.
 */
export function datenOrdner(env: Record<string, string | undefined>): string {
  const d = env.PLUGIN_DATEN?.trim();
  if (!d) throw new Error('PLUGIN_DATEN fehlt: der Leitstand übergibt den Datenordner, ohne ihn startet das Mail-Plugin nicht');
  return d;
}

if (import.meta.main) {
  let daten: string;
  try {
    daten = datenOrdner(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const log = (z: string): void => void process.stderr.write(`${new Date().toISOString()} ${z}\n`);
  const schreibe = (j: Json): void => void process.stdout.write(`${JSON.stringify(j)}\n`);
  const fabrik: ImapFabrik = imapFlow;
  const alle = lokaleWerkzeuge(mailWerkzeuge({ konten: () => baueKonten(process.env, fabrik), triageDatei: () => (mkdirSync(daten, { recursive: true }), join(daten, TRIAGE_DATEI)), pdf: textRenderer }));
  const klappe = { zu: false };
  // Der Text ist fertig (roh): der Kern stellt ihn unverändert zu, daten bleibt leer.
  const signal = new MailSignal({
    pufferDatei: join(daten, PUFFER_DATEI),
    nachholStand: join(daten, NACHHOL_DATEI),
    zugeklappt: () => klappe.zu,
    zustellen: (text) => {
      schreibe({ jsonrpc: '2.0', method: 'notifications/leitstand/ereignis', params: { art: 'mail.neu', text, daten: {} } });
      return true;
    },
  });
  const takt = new MailTakt({
    daten,
    signal,
    klappe,
    rufe: async (name, args) => {
      const d = alle.find((x) => x.name === name);
      if (!d) throw new Error(`Werkzeug ${name} fehlt`);
      const r = await d.aufruf(args, WER);
      return (r instanceof Strukturiert ? r.struktur : r) as Json;
    },
    konten: () => {
      const k = leseKonten(process.env);
      return k.ok ? k.wert.map((c) => c.name) : [];
    },
    triage: () => ({ an: /^(true|1|ja)$/i.test(process.env.PLUGIN_TRIAGE_AN?.trim() ?? ''), taktMin: Math.min(1440, Math.max(1, Number(process.env.PLUGIN_TRIAGE_TAKT_MIN) || 10)) }),
    log,
  });
  const defs = [...alle, taktWerkzeug(takt)];
  const waechter = starteWaechter({ env: process.env, daten, log, signal, melde: (art, text, daten) => schreibe({ jsonrpc: '2.0', method: 'notifications/leitstand/ereignis', params: { art, text, daten } }) });
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
