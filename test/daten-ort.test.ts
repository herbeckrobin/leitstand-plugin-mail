import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datenOrdner } from '../server.ts';

// A-2404: 1.5.0 schrieb nach cwd/daten, also in die Kopie, und die Baumprüfung sperrte den Start (Störung 127).

const wurzel = mkdtempSync(join(tmpdir(), 'mail-datenort-'));
afterAll(() => rmSync(wurzel, { recursive: true, force: true }));
const SERVER = join(import.meta.dir, '..', 'server.ts');

const starte = async (env: Record<string, string>, cwd: string, stopNachMs: number | null) => {
  const p = Bun.spawn(['bun', SERVER], { cwd, env: { PATH: process.env.PATH ?? '', HOME: wurzel, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  if (stopNachMs !== null) {
    await Bun.sleep(stopNachMs);
    p.kill();
  }
  await p.exited;
  return { code: p.exitCode, fehler: await new Response(p.stderr).text() };
};

describe('Datenordner', () => {
  test('datenOrdner liest PLUGIN_DATEN, leer oder fehlend wirft', () => {
    expect(datenOrdner({ PLUGIN_DATEN: '/x/y' })).toBe('/x/y');
    expect(() => datenOrdner({})).toThrow('PLUGIN_DATEN');
    expect(() => datenOrdner({ PLUGIN_DATEN: '  ' })).toThrow('PLUGIN_DATEN');
  });

  test('Start mit PLUGIN_DATEN legt unter cwd nichts an, die Dateien liegen im Datenordner', async () => {
    const cwd = join(wurzel, 'kopie');
    const daten = join(wurzel, 'plugin-daten');
    mkdirSync(cwd);
    mkdirSync(daten);
    await starte({ PLUGIN_DATEN: daten }, cwd, 1500);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('Start ohne PLUGIN_DATEN bricht mit Meldung ab und legt unter cwd nichts an', async () => {
    const cwd = join(wurzel, 'kopie-ohne');
    mkdirSync(cwd);
    const r = await starte({}, cwd, null);
    expect(r.code).toBe(1);
    expect(r.fehler).toContain('PLUGIN_DATEN fehlt');
    expect(readdirSync(cwd)).toEqual([]);
  });
});
