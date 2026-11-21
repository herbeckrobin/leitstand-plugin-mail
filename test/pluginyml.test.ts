import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Derselbe Parser wie im Kern (server/module/plugin-yml.ts): Bun.YAML.parse.
// Die Grenzen unten sind die des Kerns (Auftrag A-2292). Der Kern lehnt eine
// plugin.yml ab, die hier nicht besteht.
const DATEI = join(import.meta.dir, '..', 'plugin.yml');
const inhalt = readFileSync(DATEI, 'utf8');

const SCHLUESSEL = [
  'name',
  'version',
  'titel',
  'beschreibung',
  'start',
  'dauer',
  'ereignisse',
  'werkzeuge',
  'rules',
  'rechte',
  'einstellungen',
];
const ORTE = ['haupt', 'code', 'daten', 'downloads', 'tauschablage'];
// Typen der Einstellungen laut Kern; das Plugin nutzt nur string.
const TYPEN = ['string', 'number', 'boolean'];
const WERKZEUGE = [
  'posteingang',
  'suchen',
  'lesen',
  'entwuerfe_liste',
  'neue_seit',
  'nachhol_zaehle',
  'entwurf_finde',
  'gesendet_finde',
  'konto_pruefe',
  'entwurf_neu',
  'antwort_entwurf',
  'entwurf_aendern',
  'entwurf_loeschen',
  'verschieben',
  'triage_merke',
  'anhang_speichern',
];

type Werkzeug = { art: string; stufe: string; text: string; hinweis?: string };
type Einstellung = { typ: string; titel: string; geheim?: boolean; pflicht?: boolean; standard?: unknown };
type Roh = {
  name: unknown;
  version: unknown;
  titel: unknown;
  beschreibung: unknown;
  start: unknown[];
  dauer: unknown;
  ereignisse: unknown[];
  werkzeuge: Record<string, Werkzeug>;
  rules: unknown[];
  rechte: { lesen: string[]; schreiben: string[]; netz: string[] };
  einstellungen: Record<string, Einstellung>;
};

const roh = Bun.YAML.parse(inhalt) as Roh;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const NAME_UNTERSTRICH = /^[a-z0-9_]+$/;

describe('plugin.yml mit dem Parser des Kerns', () => {
  test('parst als gültiges YAML', () => {
    expect(() => Bun.YAML.parse(inhalt)).not.toThrow();
  });

  test('Datei höchstens 64 KB', () => {
    expect(statSync(DATEI).size).toBeLessThanOrEqual(64 * 1024);
  });

  test('nur bekannte Schlüssel', () => {
    for (const k of Object.keys(roh)) expect(SCHLUESSEL, k).toContain(k);
  });

  test('name: 2 bis 32 Zeichen a-z0-9-', () => {
    expect(typeof roh.name).toBe('string');
    expect(roh.name as string).toMatch(/^[a-z0-9-]{2,32}$/);
  });

  test('version ist Text im Format 1.0.0', () => {
    expect(typeof roh.version).toBe('string');
    expect(roh.version as string).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('version gleicht package.json und server.ts', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string };
    const server = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8');
    expect(pkg.version).toBe(roh.version as string);
    expect(server).toContain(`const VERSION = '${roh.version as string}';`);
  });

  test('titel höchstens 80, beschreibung höchstens 400 Zeichen', () => {
    expect(text(roh.titel, 80)).toBe(true);
    expect(text(roh.beschreibung, 400)).toBe(true);
  });

  test('start: Liste mit 1 bis 16 Einträgen', () => {
    expect(Array.isArray(roh.start)).toBe(true);
    expect(roh.start.length).toBeGreaterThanOrEqual(1);
    expect(roh.start.length).toBeLessThanOrEqual(16);
    for (const e of roh.start) expect(text(e, 300)).toBe(true);
  });

  test('dauer ist boolean', () => {
    expect(typeof roh.dauer).toBe('boolean');
  });

  test('ereignisse: höchstens 20, beginnen mit "mail."', () => {
    expect(roh.ereignisse.length).toBeLessThanOrEqual(20);
    for (const e of roh.ereignisse) {
      expect(text(e, 300)).toBe(true);
      expect(e as string).toMatch(/^mail\./);
    }
  });

  test('rules: relative .md-Pfade, höchstens 50', () => {
    expect(roh.rules.length).toBeLessThanOrEqual(50);
    for (const r of roh.rules) {
      expect(text(r, 300)).toBe(true);
      const p = r as string;
      expect(p.endsWith('.md')).toBe(true);
      expect(p.startsWith('/')).toBe(false);
      expect(p.split('/')).not.toContain('..');
    }
  });
});

describe('Werkzeuge', () => {
  test('höchstens 100, genau die erwarteten', () => {
    const namen = Object.keys(roh.werkzeuge);
    expect(namen.length).toBeLessThanOrEqual(100);
    expect([...namen].sort()).toEqual([...WERKZEUGE].sort());
  });

  test('Name a-z0-9_, art, stufe, text höchstens 300, hinweis höchstens 160', () => {
    for (const [name, w] of Object.entries(roh.werkzeuge)) {
      expect(name).toMatch(NAME_UNTERSTRICH);
      expect(['lesen', 'schreiben'], name).toContain(w.art);
      expect(['frei', 'karte', 'aus'], name).toContain(w.stufe);
      expect(text(w.text, 300), `${name}.text`).toBe(true);
      if (w.hinweis !== undefined) expect(text(w.hinweis, 160), `${name}.hinweis`).toBe(true);
    }
  });

  test('echte Umlaute bleiben erhalten', () => {
    expect(roh.werkzeuge.entwuerfe_liste?.text).toBe('Listet die Entwürfe eines Kontos');
    expect(inhalt).not.toContain('u{');
  });
});

describe('Rechte', () => {
  test('nur lesen, schreiben, netz mit höchstens 20 Einträgen', () => {
    for (const [k, liste] of Object.entries(roh.rechte)) {
      expect(['lesen', 'schreiben', 'netz'], k).toContain(k);
      expect(liste.length).toBeLessThanOrEqual(20);
      for (const e of liste) expect(text(e, 300)).toBe(true);
    }
  });

  test('lesen und schreiben nur bekannte Orte', () => {
    for (const o of [...roh.rechte.lesen, ...roh.rechte.schreiben]) expect(ORTE).toContain(o);
  });

  test('netz nur Hostnamen', () => {
    for (const h of roh.rechte.netz) expect(h).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i);
  });
});

describe('Einstellungen', () => {
  test('titel höchstens 80, typ aus der Liste, Flags boolean', () => {
    for (const [name, e] of Object.entries(roh.einstellungen)) {
      expect(text(e.titel, 80), `${name}.titel (${e.titel?.length})`).toBe(true);
      expect(TYPEN, name).toContain(e.typ);
      if (e.geheim !== undefined) expect(typeof e.geheim, `${name}.geheim`).toBe('boolean');
      if (e.pflicht !== undefined) expect(typeof e.pflicht, `${name}.pflicht`).toBe('boolean');
      if (e.geheim === true) expect(e.standard, `${name}: geheim ohne standard`).toBeUndefined();
    }
  });
});
