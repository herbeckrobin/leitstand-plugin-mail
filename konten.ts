import type { Absender } from './bau.ts';
import { imapFlow, ImapVerbindung, type ImapLike, type KontoZugang } from './imap.ts';
import type { Konto } from './werkzeuge.ts';

// Konten und Passwörter kommen aus den Einstellungen des Plugins (plugin.yml): `konten` ist eine JSON-Liste, `passwoerter`
// ein geheimes JSON-Objekt Kontoname -> Passwort. Fehlertexte nennen nur Schlüssel und Kontonamen, nie einen Wert.

export interface KontoKonfig {
  name: string;
  host: string;
  port: number;
  benutzer: string;
  /** Absenderadresse, Standard der Benutzer. */
  adresse: string;
  /** Anzeigename im Absender, Standard der Kontoname. */
  anzeigename: string;
  loeschen: 'expunge' | 'papierkorb';
}

type Umgebung = Record<string, string | undefined>;
type Ergebnis<T> = { ok: true; wert: T } | { ok: false; fehler: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parst die Einstellung `konten`. Der Rohtext kommt nie in eine Fehlermeldung. */
export function leseKonten(env: Umgebung = process.env): Ergebnis<KontoKonfig[]> {
  const roh = env.PLUGIN_KONTEN;
  if (!roh) return { ok: true, wert: [] };
  let j: unknown;
  try {
    j = JSON.parse(roh);
  } catch {
    return { ok: false, fehler: 'Einstellung konten ist kein gültiges JSON' };
  }
  if (!Array.isArray(j)) return { ok: false, fehler: 'Einstellung konten muss eine Liste sein' };
  const konten: KontoKonfig[] = [];
  for (const [i, e] of j.entries()) {
    const o = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    const name = text(o.name);
    const host = text(o.host);
    const benutzer = text(o.benutzer);
    if (!name || !host || !benutzer) return { ok: false, fehler: `Einstellung konten, Eintrag ${i + 1}: name, host und benutzer sind Pflicht` };
    const port = o.port === undefined ? 993 : o.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, fehler: `Konto ${name}: port ungültig` };
    if (o.loeschen !== undefined && o.loeschen !== 'expunge' && o.loeschen !== 'papierkorb') return { ok: false, fehler: `Konto ${name}: loeschen muss expunge oder papierkorb sein` };
    if (konten.some((k) => k.name === name)) return { ok: false, fehler: `Konto ${name} steht doppelt in konten` };
    konten.push({ name, host, port, benutzer, adresse: text(o.adresse) ?? benutzer, anzeigename: text(o.anzeigename) ?? name, loeschen: o.loeschen === 'papierkorb' ? 'papierkorb' : 'expunge' });
  }
  return { ok: true, wert: konten };
}

/** Parst die Einstellung `passwoerter`. Fehlt sie oder ist sie kaputt, hat kein Konto ein Passwort. */
export function lesePasswoerter(env: Umgebung = process.env): Ergebnis<Record<string, string>> {
  const roh = env.PLUGIN_PASSWOERTER;
  if (!roh) return { ok: false, fehler: 'Einstellung passwoerter fehlt' };
  let j: unknown;
  try {
    j = JSON.parse(roh);
  } catch {
    // Kein Teil des Rohtexts in die Meldung: ein Parsefehler zitiert sonst die Stelle, an der das Passwort steht.
    return { ok: false, fehler: 'Einstellung passwoerter ist kein gültiges JSON (erwartet: Objekt Kontoname -> Passwort)' };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, fehler: 'Einstellung passwoerter muss ein Objekt Kontoname -> Passwort sein' };
  const aus: Record<string, string> = {};
  for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v) aus[k] = v;
  return { ok: true, wert: aus };
}

export function leseSignatur(env: Umgebung = process.env): { html: string; text: string } | null {
  const html = env.PLUGIN_SIGNATUR_HTML?.trim();
  const klar = env.PLUGIN_SIGNATUR_TEXT?.trim() ?? '';
  return html || klar ? { html: html ?? '', text: klar } : null;
}

export type ImapFabrik = (z: KontoZugang) => ImapLike;

/** Die Konten für die Werkzeuge. Ein Konto ohne Passwort ist nicht bereit und sagt es beim Aufruf. */
export function baueKonten(env: Umgebung = process.env, fabrik: ImapFabrik = imapFlow): Konto[] {
  const k = leseKonten(env);
  const p = lesePasswoerter(env);
  const sig = leseSignatur(env);
  const klartext = sig?.text ?? '';
  const liste = k.ok ? k.wert : [];
  return liste.map((c) => {
    const pass = p.ok ? p.wert[c.name] : undefined;
    const neu = (): ImapLike => {
      if (!pass) throw new Error(`Kein Passwort für Konto ${c.name}`);
      return fabrik({ host: c.host, port: c.port, user: c.benutzer, pass });
    };
    const absender: Absender = {
      name: c.anzeigename,
      adresse: c.adresse,
      signatur: klartext,
      // Nur Text gesetzt: kein HTML-Teil, signaturTeil baut HTML aus dem Text.
      signaturHtml: sig?.html ? () => ({ html: sig.html, text: sig.text, bilder: [] }) : undefined,
    };
    return {
      name: c.name,
      absender,
      loeschen: c.loeschen,
      verbindung: new ImapVerbindung(neu),
      neuerClient: neu,
      nichtBereit: () => (pass ? null : p.ok ? `Kein Passwort für Konto ${c.name} in der Einstellung passwoerter` : p.fehler),
    };
  });
}
