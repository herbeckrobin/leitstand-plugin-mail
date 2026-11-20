import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Derselbe Parser wie im Kern (server/module/plugin-yml.ts): Bun.YAML.parse.
// Der Kern lehnt eine plugin.yml ab, die hier nicht parst.
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

describe('plugin.yml mit dem Parser des Kerns', () => {
  const inhalt = readFileSync(join(import.meta.dir, '..', 'plugin.yml'), 'utf8');

  test('parst als gültiges YAML', () => {
    expect(() => Bun.YAML.parse(inhalt)).not.toThrow();
  });

  test('nennt alle Werkzeuge mit art, stufe und text', () => {
    const roh = Bun.YAML.parse(inhalt) as { werkzeuge: Record<string, { art: string; stufe: string; text: string }> };
    expect(Object.keys(roh.werkzeuge).sort()).toEqual([...WERKZEUGE].sort());
    for (const [name, w] of Object.entries(roh.werkzeuge)) {
      expect(['lesen', 'schreiben']).toContain(w.art);
      expect(['frei', 'karte']).toContain(w.stufe);
      expect(typeof w.text, name).toBe('string');
      expect(w.text.length, name).toBeGreaterThan(10);
    }
  });

  test('echte Umlaute bleiben erhalten', () => {
    const roh = Bun.YAML.parse(inhalt) as { werkzeuge: Record<string, { text: string }> };
    expect(roh.werkzeuge.entwuerfe_liste?.text).toBe('Listet die Entwürfe eines Kontos');
    expect(inhalt).not.toContain('u{');
  });
});
