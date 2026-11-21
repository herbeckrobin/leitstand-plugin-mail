import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dist/server.js ist eingecheckt, der Leitstand startet es. Dieser Test baut den Quelltext mit demselben Befehl wie
// "bau" in der package.json neu und vergleicht. Gemessen (A-2310): zwei Bauten sind byte-gleich, auch nach
// frischem "bun install --frozen-lockfile". Einzige Abweichung ist der absolute Pfad des Checkouts in zwei
// "var __dirname = ..."-Zeilen (pino, thread-stream), der folgt dem Ordner, in dem gebaut wurde. Den ebnen wir ein.
const ROOT = join(import.meta.dir, '..');
const ebne = (s: string): string => s.replace(/(__dirname = ")[^"]*?(\/node_modules\/)/g, '$1<root>$2');

test('dist/server.js passt zum Quelltext', async () => {
  const ziel = mkdtempSync(join(tmpdir(), 'mail-dist-'));
  try {
    const p = Bun.spawn(['bun', 'build', '--target', 'bun', 'server.ts', '--outfile', join(ziel, 'server.js')], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    const fehler = await new Response(p.stderr).text();
    expect(await p.exited, fehler).toBe(0);
    const neu = ebne(readFileSync(join(ziel, 'server.js'), 'utf8'));
    const alt = ebne(readFileSync(join(ROOT, 'dist', 'server.js'), 'utf8'));
    expect(neu === alt, 'dist ist veraltet, bun run bau').toBe(true);
  } finally {
    rmSync(ziel, { recursive: true, force: true });
  }
});

test('package.json: bau baut genau diesen Befehl, prepare setzt die Hooks', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts.bau).toBe('bun build --target bun server.ts --outfile dist/server.js');
  expect(pkg.scripts.prepare).toBe('sh skripte/hooks-setzen.sh');
});
