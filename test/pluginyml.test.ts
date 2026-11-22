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
  'roh',
  'takt',
  'aktionen',
  'hinweise',
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
  'takt',
  'anhang_speichern',
];
// Felder aus dem Vertrag mit dem Kern (A-2282): leseYml auf main kennt takt, aktionen, hinweise, roh und
// nur_dienst erst mit dem Kern-Merge, darum prüft dieser Test sie gegen den Vertrag und nicht gegen leseYml.
const AKTIONEN = ['karte_neu', 'karte_erledige', 'stoerung', 'vermerk', 'modell'];
const TAKT_KONTEXT = ['klappe', 'karten', 'aufgaben', 'modell'];

type Werkzeug = { art: string; stufe: string; text: string; hinweis?: string; nur_dienst?: boolean };
type Einstellung = { typ: string; titel: string; geheim?: boolean; pflicht?: boolean; standard?: unknown };
type Roh = {
  name: unknown;
  version: unknown;
  titel: unknown;
  beschreibung: unknown;
  start: unknown[];
  dauer: unknown;
  ereignisse: unknown[];
  roh: unknown[];
  takt: { werkzeug: unknown; sekunden: unknown; kontext: unknown[] };
  aktionen: unknown[];
  hinweise: Record<string, unknown>;
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

describe('Takt, Aktionen, Hinweise und roh (Vertrag mit dem Kern)', () => {
  test('takt: werkzeug zeigt auf ein Werkzeug, sekunden ganze Zahl 10 bis 3600, kontext aus der Liste', () => {
    expect(Object.keys(roh.werkzeuge)).toContain(roh.takt.werkzeug as string);
    expect(roh.takt.werkzeug).toBe('takt');
    expect(Number.isInteger(roh.takt.sekunden)).toBe(true);
    expect(roh.takt.sekunden as number).toBeGreaterThanOrEqual(10);
    expect(roh.takt.sekunden as number).toBeLessThanOrEqual(3600);
    for (const k of roh.takt.kontext) expect(TAKT_KONTEXT).toContain(k as string);
    expect(new Set(roh.takt.kontext).size).toBe(roh.takt.kontext.length);
  });

  test('takt ist ein Dienst-Werkzeug: nur_dienst, art schreiben, stufe frei, nie als lesen für Rollen', () => {
    const w = roh.werkzeuge.takt!;
    expect(w.nur_dienst).toBe(true);
    expect(w.art).toBe('schreiben');
    expect(w.stufe).toBe('frei');
    // Kein anderes Werkzeug trägt nur_dienst.
    for (const [name, x] of Object.entries(roh.werkzeuge)) if (name !== 'takt') expect(x.nur_dienst, name).toBeUndefined();
  });

  test('aktionen: höchstens die fünf bekannten Arten, ohne Doppelte', () => {
    expect(roh.aktionen.length).toBeGreaterThanOrEqual(1);
    for (const a of roh.aktionen) expect(AKTIONEN).toContain(a as string);
    expect(new Set(roh.aktionen).size).toBe(roh.aktionen.length);
  });

  test('roh ist Teilmenge von ereignisse', () => {
    for (const a of roh.roh) expect(roh.ereignisse).toContain(a);
  });

  test('hinweise: Art steht in ereignisse, Datei relativ, UTF-8, höchstens 4000 Zeichen', () => {
    for (const [art, datei] of Object.entries(roh.hinweise)) {
      expect(roh.ereignisse).toContain(art);
      expect(text(datei, 300)).toBe(true);
      const p = datei as string;
      expect(p.startsWith('/')).toBe(false);
      expect(p.split('/')).not.toContain('..');
      const inh = readFileSync(join(import.meta.dir, '..', p), 'utf8');
      expect(inh.length).toBeGreaterThan(0);
      expect(inh.length).toBeLessThanOrEqual(4000);
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

  test('Triage-Einstellungen: Typ und Vorgabe, wie server.ts sie liest', () => {
    expect(roh.einstellungen.triage_an).toMatchObject({ typ: 'boolean', standard: false });
    expect(roh.einstellungen.triage_takt_min).toMatchObject({ typ: 'number', standard: 10 });
  });
});
