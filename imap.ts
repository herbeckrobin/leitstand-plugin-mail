import { ImapFlow } from 'imapflow';

// IMAP-Anbindung des Mail-Moduls: eine Verbindung je Konto, alle Aufrufe nacheinander. Bricht sie ab, baut der
// nächste Aufruf sie neu auf. Nach 5 min ohne Aufruf meldet sie sich ab. imapflow ohne Logger, damit weder
// Passwort noch Inhalt im Log landen.

export interface Adresse {
  name?: string;
  address?: string;
}

export interface Umschlag {
  date?: Date | string;
  subject?: string;
  from?: Adresse[];
  to?: Adresse[];
  cc?: Adresse[];
  messageId?: string;
  inReplyTo?: string;
}

export interface ImapNachricht {
  uid: number;
  envelope?: Umschlag;
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
  source?: Buffer;
  /** Angeforderte Kopfzeilen (headers: [...]), roh. */
  headers?: Buffer;
}

export interface ImapSuche {
  all?: boolean;
  seen?: boolean;
  from?: string;
  subject?: string;
  since?: Date;
  before?: Date;
  header?: Record<string, string>;
}

/** Was das Mail-Modul von imapflow braucht. Im Test der IMAP-Ersatz. */
export interface ImapLike {
  usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  status(path: string, q: { uidNext: true; uidValidity: true }): Promise<{ uidNext?: number; uidValidity?: bigint | number }>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(q: ImapSuche, o: { uid: true }): Promise<number[] | false | undefined>;
  fetch(range: number[] | string, q: Record<string, boolean | string[]>, o: { uid: true }): AsyncIterable<ImapNachricht>;
  fetchOne(uid: string, q: Record<string, boolean>, o: { uid: true }): Promise<ImapNachricht | false>;
  append(path: string, inhalt: Buffer, flags: string[]): Promise<{ uid?: number } | false>;
  messageDelete(uids: string, o: { uid: true }): Promise<boolean>;
  messageMove(uids: string, ziel: string, o: { uid: true }): Promise<{ uidMap?: Map<number, number> } | false>;
}

export interface KontoZugang {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export function imapFlow(z: KontoZugang): ImapLike {
  return new ImapFlow({ host: z.host, port: z.port, secure: true, auth: { user: z.user, pass: z.pass }, logger: false, emitLogs: false }) as unknown as ImapLike;
}

export class ImapVerbindung {
  private client: ImapLike | null = null;
  private kette: Promise<unknown> = Promise.resolve();
  private leer: ReturnType<typeof setTimeout> | null = null;
  private ordnerCache: { path: string; specialUse?: string }[] | null = null;

  constructor(
    private neu: () => ImapLike | Promise<ImapLike>,
    private leerlaufMs = 5 * 60 * 1000,
  ) {}

  /** Führt f mit einer verbundenen Sitzung aus, nie zwei gleichzeitig. */
  mit<T>(f: (c: ImapLike) => Promise<T>): Promise<T> {
    const lauf = this.kette.then(async () => {
      if (this.leer) clearTimeout(this.leer);
      try {
        const c = await this.verbunden();
        return await f(c);
      } finally {
        this.leer = setTimeout(() => void this.schliesse(), this.leerlaufMs);
        (this.leer as { unref?: () => void }).unref?.();
      }
    });
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  private async verbunden(): Promise<ImapLike> {
    if (this.client?.usable) return this.client;
    this.client = null;
    this.ordnerCache = null;
    const c = await this.neu();
    // Fehler-Ereignisse fängt imapflow sonst als unbehandelt, der Prozess stürbe.
    (c as unknown as { on?: (e: string, f: () => void) => void }).on?.('error', () => {});
    await c.connect();
    this.client = c;
    return c;
  }

  async ordner(c: ImapLike): Promise<{ path: string; specialUse?: string }[]> {
    this.ordnerCache ??= await c.list();
    return this.ordnerCache;
  }

  async schliesse(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.ordnerCache = null;
    if (c?.usable) await c.logout().catch(() => {});
  }
}
