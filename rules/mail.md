# Mail über das Gateway des Leitstands

Mail läuft über die Werkzeuge `mcp__leitstand__mail_*` (IMAP direkt am Server). Es gibt kein eigenes `osascript` und keinen Mail.app-MCP. Alle Werkzeuge haben `konto`, ohne Angabe gilt das erste eingerichtete Konto.

| Werkzeug | Zweck |
|---|---|
| `mail_posteingang` | Neueste Mails eines Ordners (Standard INBOX), `anzahl`, `nur_ungelesen` |
| `mail_suchen` | Nach `von`, `betreff`, `seit`, `bis` (JJJJ-MM-TT), mindestens eins davon, `ordner` wählbar |
| `mail_lesen` | Kopf, Text und Anhangliste (Index, Name, Typ, Größe) zu einer `uid` |
| `mail_anhang_speichern` | Anhang nach `ziel` speichern, überschreibt nie |
| `mail_als_pdf` | Mail als PDF-Textfassung (ohne Bilder) nach `ziel` (.pdf), überschreibt nie |
| `mail_antwort_entwurf` | Antwort im Verlauf mit Zitat und Signatur, `allen`, `anhaenge` |
| `mail_entwurf_neu` | Neuer Entwurf mit `an`, `cc`, `betreff`, `text`, `anhaenge` |
| `mail_entwuerfe_liste` | Entwürfe im Entwürfe-Ordner |
| `mail_entwurf_aendern` | Entwurf neu ablegen, alten löschen, Anhänge bleiben standardmäßig |
| `mail_entwurf_loeschen` | Nur Entwürfe, die das Gateway selbst angelegt hat |
| `mail_verschieben` | `uids` in einen anderen Ordner, etwa Archiv |

Fünf weitere Lesewerkzeuge ruft der Leitstand-Kern selbst auf, Sessions brauchen sie selten: `mail_neue_seit` (neue INBOX-Mails seit einem Stand), `mail_nachhol_zaehle` (liegengebliebene Mails als Zahl), `mail_entwurf_finde` (Entwurf per `uuid` oder `uid`, `mit_inhalt` für Text und Anhangsliste), `mail_gesendet_finde` (Gesendet-Ordner, genau eins von `in_reply_to`, `betreff`, `uuid`) und `mail_konto_pruefe` (Anmeldung und Ordner je Konto, nur lesend).

Was das Gateway nicht kann:

- **Versenden gibt es nicht.** Kein SMTP. Entwürfe schickt der Mensch selbst ab.
- **Eine UID gilt nur im Ordner, aus dem sie kommt.** Für Lesen, Anhang, Antwort und Verschieben denselben `konto` und `ordner` wie bei der Suche angeben.
- **Gesucht wird nur in Absender, Betreff und Datum, nicht im Mailtext.** Ein Stichwort aus dem Text findet man über Absender und Zeitraum und `mail_lesen`. Ein leerer Treffer heißt nicht "gibt es nicht".
- **Es gibt keine Ordnerliste.** Der Gesendet-Ordner heißt je Konto anders, ein unbekannter Name meldet "Ordner ... gibt es nicht".
- `mail_lesen` kürzt den Text bei 60.000 Zeichen, `anzahl` ist auf 100 begrenzt.

Anhänge in Entwürfen:

- `anhaenge` ist eine Liste absoluter Pfade, nur unter dem Hauptverzeichnis des Leitstands (`/Volumes/Work`). Alles andere lehnt das Gateway ab, auch `/private/tmp` und das Home. Das gilt ebenso für `ziel` bei `mail_anhang_speichern`.
- Zusammen höchstens 25 MB.
- Der Text endet mit Gruß und Vornamen (zum Beispiel: Beste Grüße, Vorname). Die Signatur darunter bringt nur die Karte mit Kontaktdaten, nie die Grußformel.
- Nach dem Anlegen prüfen, nicht behaupten: `mail_lesen` auf die UID aus der Antwort, Anhangliste und Text ansehen.
