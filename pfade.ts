import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

// Welche Pfade das Plugin lesen (Anhang für einen Entwurf) oder schreiben darf (Anhang speichern). Erlaubt ist allein das
// Hauptverzeichnis, das der Leitstand als PLUGIN_ORT_HAUPT übergibt (rechte.lesen und rechte.schreiben: haupt), nie versteckte
// Teile darunter (.env, .git, .claude). Fehlt der Ort, wird alles abgelehnt. Symlinks zählen mit ihrem Ziel.

export interface Wurzeln {
  /** Das Hauptverzeichnis oder null, wenn der Leitstand keins übergeben hat. */
  haupt: () => string | null;
}

export const KEIN_HAUPT = 'Kein Hauptverzeichnis bekannt (Ort haupt), Dateien lesen und speichern sind zu';

export const wurzelnAusUmgebung = (env: Record<string, string | undefined> = process.env): Wurzeln => ({ haupt: () => env.PLUGIN_ORT_HAUPT || null });

function echt(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function istLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function drin(p: string, w: string): boolean {
  return p === w || p.startsWith(w.endsWith(sep) ? w : w + sep);
}

/** null heißt erlaubt, sonst der Grund. Für eine neue Datei zählt der echte Elternordner. */
export function pruefePfad(p: string, w: Wurzeln): string | null {
  if (!isAbsolute(p)) return 'Pfad muss absolut sein';
  const haupt = w.haupt();
  if (!haupt || !isAbsolute(haupt)) return KEIN_HAUPT;
  const abs = resolve(p);
  const eltern = echt(dirname(abs));
  if (!eltern) return 'Ordner gibt es nicht';
  const voll = join(eltern, basename(abs));
  // Ein hängender Symlink löst sich nicht auf, der Linkpfad läge im Hauptverzeichnis, geschrieben würde aber am Ziel.
  if (!echt(voll) && istLink(voll)) return 'Pfad ist ein Symlink ohne Ziel';
  const ziel = echt(voll) ?? voll;
  const wurzel = echt(haupt);
  if (!wurzel) return 'Hauptverzeichnis gibt es nicht';
  if (!drin(ziel, wurzel)) return 'Pfad liegt außerhalb des Hauptverzeichnisses';
  const teile = ziel.slice(wurzel.length).split(sep).filter(Boolean);
  if (teile.some((t) => t.startsWith('.'))) return 'Versteckte Ordner und Dateien sind gesperrt';
  return null;
}

/** Dateiname aus einem Anhang, ohne Pfadteile und Steuerzeichen. */
export function sichererName(n: string): string {
  const s = n
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return s || 'anhang';
}
