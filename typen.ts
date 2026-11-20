// Gemeinsame Typen des Plugins. Das Plugin importiert nichts aus dem Leitstand.

/** Fehler mit Text für die Session. Alles andere meldet der Server als "Interner Fehler" ohne Details. */
export class WerkzeugFehler extends Error {}

export interface Aufrufer {
  /** Kennung im Entwurfs-Kopf (X-Leitstand-Entwurf). Das Plugin sieht die Session nicht, darum fest. */
  session: string;
}

export interface Werkzeug {
  name: string;
  beschreibung: string;
  schema: Record<string, unknown>;
  /** Nur lesen, nichts ändern (Hinweis an Claude Code, die Art steht in der plugin.yml). */
  nurLesen?: boolean;
  aufruf: (args: Record<string, unknown>, wer: Aufrufer) => Promise<unknown>;
}
