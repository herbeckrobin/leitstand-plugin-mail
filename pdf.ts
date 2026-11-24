import { htmlZuBloecken, textZuBloecken, type Block } from './html.ts';

// Mail als PDF (A-2396). Dieses Modul kennt keine PDF-Bibliothek: es baut aus der Mail ein Dokument (Kopf und Blöcke) und
// reicht es an einen Renderer. Der Renderer ist die Naht: heute die Textfassung (pdf-text.ts, pdf-lib, nur Text), später
// kann ein Browser-Renderer dieselbe Schnittstelle bedienen, ohne dass Werkzeug oder Tests sich ändern.

export interface PdfKopf {
  von: string;
  datum: string;
  betreff: string;
}

export interface PdfDokument {
  kopf: PdfKopf;
  bloecke: Block[];
}

/** 'text': aus HTML oder Plaintext gebaut, ohne Bilder und ohne Layout der Mail. */
export type PdfFassung = 'text';

export interface PdfRenderer {
  fassung: PdfFassung;
  /** Liefert die PDF-Bytes. Darf nichts laden und nichts außerhalb des Speichers schreiben. */
  rendere: (d: PdfDokument) => Promise<Uint8Array>;
}

export interface MailQuelle {
  von: string;
  datum: Date | null;
  betreff: string;
  html: string | null;
  text: string | null;
}

const MAX_BLOECKE = 5000;

const datumText = (d: Date | null): string =>
  d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(d)
    : '';

/** Quelle ist das HTML der Mail, sonst ihr Plaintext. Ein HTML ohne lesbaren Text fällt auf den Plaintext zurück. */
export function baueDokument(m: MailQuelle): PdfDokument {
  let bloecke: Block[] = m.html ? htmlZuBloecken(m.html) : [];
  if (!bloecke.length && m.text) bloecke = textZuBloecken(m.text);
  return {
    kopf: { von: m.von, datum: datumText(m.datum), betreff: m.betreff || '(ohne Betreff)' },
    bloecke: bloecke.slice(0, MAX_BLOECKE),
  };
}
