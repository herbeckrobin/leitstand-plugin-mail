# mail

Mail über IMAP als Plugin des Leitstands: lesen, suchen, Entwürfe anlegen, ändern und verschieben, dazu der Postfach-Wächter, der neue Mails als Ereignis `mail.neu` meldet. Versenden gibt es nicht, kein SMTP, kein Transport: Entwürfe landen im Entwürfe-Ordner, Robin schickt sie selbst ab. Eigenes Repo, importiert nichts aus dem Leitstand. Entscheidungen im Leitstand-Repo: ADR 0038 (Plugins), 0042 (Ereignis-Kanal), 0043 (Dauerprozess).

## Werkzeuge

Das Gateway stellt `mail_` voran, im Plugin heißen sie ohne Präfix.

- lesend (`stufe: frei`): `posteingang`, `suchen`, `lesen`, `entwuerfe_liste`, dazu die Kernwerkzeuge `neue_seit`, `nachhol_zaehle`, `entwurf_finde`, `gesendet_finde`, `konto_pruefe` (unten)
- schreibend, `stufe: frei`: `entwurf_neu`, `antwort_entwurf`, `entwurf_aendern`, `entwurf_loeschen`, `verschieben`, `triage_merke`
- schreibend, `stufe: karte`: `anhang_speichern` (schreibt eine Datei aus einer fremden Mail auf die Platte)
- schreibend, `stufe: frei` (Vorschlag): `als_pdf`, siehe "Mail als PDF"

## Mail als PDF

`als_pdf` (`konto`, `ordner`, `uid`, `ziel`) legt eine Mail als PDF unter `ziel` ab, gedacht für Rechnungen, die nur im Mailtext stehen. `ziel` ist ein neuer absoluter Pfad auf `.pdf` unter `haupt`, der Ordner muss es geben, vorhandene Dateien werden nie überschrieben, versteckte Teile sind gesperrt (dieselben Regeln wie `anhang_speichern`). Antwort: `gespeichert`, `bytes`, `fassung`.

- **Fassung `text`**: Kopf mit Von, Datum, Betreff, darunter der Text der Mail (HTML, sonst Plaintext) als Überschriften, Absätze, Listen und einfache Tabellen mit durchsuchbarer Textebene. Bilder und das Layout der Mail fallen weg. Das HTML wird nur zu Text gelesen: Skript, Style, Frames und Bilder werden verworfen, nichts wird nachgeladen, es gibt kein Netz.
- **Naht**: `pdf.ts` baut das Dokument (Kopf und Blöcke aus `html.ts`) und reicht es an einen `PdfRenderer`. Ein Browser-Renderer könnte später dieselbe Schnittstelle bedienen, ohne dass Werkzeug oder Tests sich ändern. Er bräuchte im Kern ein Recht, ein Programm zu starten, und ist darum nicht Teil dieser Version.
- **Schrift**: Liberation Sans Regular und Bold unter `fonts/`, SIL Open Font License 1.1 (`fonts/LICENSE.txt`), zusammen rund 0,8 MB.

Die Stufen sind der Vorschlag aus dem bisherigen Gateway-Modul (10 frei, 1 Karte), die fünf Kernwerkzeuge sind lesend und `frei`. Bei Aufnahme und Update zeigt die Karte sie, Robin bestätigt oder ändert sie.

## Rollenregel

`rules/mail.md` liegt im Plugin, `plugin.yml` führt sie unter `rules: [rules/mail.md]`. Sie ist die Mail-Regel für Rollen mit diesem Plugin (Kopie der bisherigen Modulregel aus dem Leitstand-Repo).

## Strukturiertes Ergebnis

`posteingang`, `suchen` und `entwuerfe_liste` liefern neben dem Text (unverändert, für Sessions) ein MCP-`structuredContent`: `{ konto, ordner, mails: [...] }`. Je Mail: `konto`, `ordner`, `uid`, `message_id`, `betreff`, `von`, `an`, `cc` (je Liste aus `{ name, adresse }`), `datum` (ISO), `flags` (IMAP-Flags wie `\Seen`, `\Draft`), `in_reply_to`, `references` (Liste von Message-IDs). Damit ordnet der Leitstand einen Entwurf seiner Karte zu. `references` kommt aus der Kopfzeile References, die die Liste dafür mit abruft. Gesendet-Ordner: `posteingang` oder `suchen` mit `ordner`. Alle anderen Werkzeuge liefern nur Text.

## Werkzeuge für den Kern

Der Leitstand-Kern ruft diese Werkzeuge auf und prüft die Antworten gegen seine Zod-Schemas (Vertrag: `server/mail-plugin.ts` im Leitstand-Repo). Jede Antwort trägt `structuredContent` in genau dieser Form, daneben steht ein kurzer Text nur aus Zahlen (nie Betreff, Absender oder Inhalt).

- `neue_seit` (`konto`, `uid_next?`, `uid_validity?`): neue INBOX-Mails seit dem Stand. Ohne vollständigen Stand oder bei geänderter `uid_validity` gilt der heutige Stand als Basis, `mails` bleibt leer. Höchstens 50 Mails (die neuesten, aufsteigend nach UID), der Rest zählt in `ausgelassen`. Antwort: `{ konto, stand: { uid_next, uid_validity }, mails: [{ uid, betreff, von }], ausgelassen }`.
- `nachhol_zaehle`: INBOX-Mails über alle Konten, älter als 24 h, ohne Triage-Entscheidung oder als `unklar` gemerkt (liest `daten/mail-triage.json`). Antwort: `{ anzahl }`, `null`, wenn ein Konto nicht lesbar ist.
- `entwurf_finde` (`konto`, `uuid` oder `uid`, `mit_inhalt?`): Entwurf im Entwürfe-Ordner (Special-Use `\Drafts`). `uuid` ist die Kopfzeile `X-Universally-Unique-Identifier`. Antwort: `{ konto, gefunden, entwurf: { Kopf, inhalt: { text, html, anhaenge } | null } | null }`.
- `gesendet_finde` (`konto`, genau eins von `in_reply_to`, `betreff` (ohne `Re:`/`Aw:`, Plugin entfernt sie auch selbst), `uuid`; `seit_ms?`): Gesendet-Ordner per Special-Use `\Sent`, neueste zuerst, höchstens 20. Antwort: `{ konto, ordner, mails: [Kopf] }`, `ordner` ist `null` ohne Gesendet-Ordner.
- `konto_pruefe` (`konto?`): meldet sich frisch an und liest die Ordnerliste, sonst nichts. Antwort: `{ konten: [{ konto, ok, fehler, ordner: { entwuerfe, gesendet, papierkorb } }] }`. `fehler` nennt nur die Art (Anmeldung abgelehnt, Verbindungscode), nie Passwort oder Serverantwort.

Der Kopf: `uid`, `message_id`, `in_reply_to`, `betreff`, `an`, `cc` (je `{ name, adresse }`), `datum` (ISO), `flags`.

## Dauerprozess und Ereignis

`dauer: true`: das Gateway startet den Prozess beim Laden und hält ihn am Leben (Neustart mit Backoff, siehe `docs/plugin-vorlage.md` im Leitstand-Repo). Der Wächter hält je Konto eine IMAP-Verbindung mit IDLE auf INBOX und sieht den Gesendet-Ordner im Takt nach. Gezählt wird über UIDNEXT, eine Lücke nach einem Abbruch oder Neustart zählt genau einmal, ein Wechsel der UIDVALIDITY setzt eine neue Basis ohne Zählung.

Gemeldet wird die MCP-Notification `notifications/leitstand/ereignis` mit `art: mail.neu` im Rahmen `roh` (plugin.yml: `roh: [mail.neu]`): `text` ist der fertige Channel-Text (`<channel source="mailsignal" anzahl="2" gesendet="1">2 neue Mails, 1 gesendet</channel>`), `daten` bleibt leer. Das Plugin zählt, puffert (`mailsignal-puffer.json`) und hält den Nachhol-Stand (`mailsignal-nachhol.json`) im Datenordner, `signal.ts`. Bei zugeklappter Klappe (aus dem Takt-Kontext) bleibt der Text im Puffer und kommt als "gesammelt" nach. Nie Betreff, Adresse oder Inhalt. Den Hinweis für die Poststelle liefert `hinweise/mail-neu.md` (plugin.yml: `hinweise`).

## Takt und Aktionen

Das Werkzeug `takt` (plugin.yml: `nur_dienst: true`, keine Rolle ruft es) ruft der Kern alle 30 Sekunden mit `jetzt`, `klappe`, `karten`, `aufgaben` und `modell` aus dem Kontext (`takt.kontext`). Die Antwort ist ein JSON-Text `{ "aktionen": [...] }`, höchstens 20. Was das Plugin darin tut (`takt.ts`):

- **Nachholen:** stündlich die Zahl liegengebliebener Mails, nur über das Signal, keine Aktion.
- **Triage** (Einstellung `triage_an`, Abstand `triage_takt_min`): neue Mails je Konto über `neue_seit`. Die Regel aus den Aufgaben (Ball bei Robin, Frist bis morgen) entscheidet zuerst, den Rest bestellt das Plugin als Aktion `modell` (höchstens 3 Anfragen mit je 20 Mails je Takt). Das Ergebnis kommt im nächsten Takt in `kontext.modell`. Fehlt es oder schlägt es fehl, zählt die Mail als "braucht dich". Ergebnis ist eine Sammelkarte als `karte_neu` mit Schlüssel `mail-triage-<Beginn>`. Stand und Sammlung liegen wie im Kern in `mailtriage-stand.json` im Datenordner.
- **Entwurf-Prüfer:** für jede offene Review-Karte mit `entwurf` sucht das Plugin den Entwurf (`entwurf_finde`) und das Gesendete (`gesendet_finde`). Liegt es dort mit Message-ID, kommt `karte_erledige` mit der Message-ID als `beleg`. Ohne Message-ID bleibt die Karte offen.
- **Störungen:** `stoerung` mit Stelle `mail.entwurf` oder `mail.triage`, einmal je Ursache, nie mit Postfachinhalt.

Nicht gebaut: Vorschau auf der Review-Karte und die Tagesablauf-Einstellung (ADR 0051). Der Kern kennt `takt`, `aktionen`, `hinweise`, `roh` und `nur_dienst` in `leseYml` erst nach dem Merge von A-2344, bis dahin prüft `test/pluginyml.test.ts` diese Felder gegen den Vertrag.

## Einstellungen

- `konten` (Pflicht): JSON-Liste, je Eintrag `name`, `host`, `benutzer`, optional `port` (993), `adresse`, `anzeigename`, `loeschen` (`expunge` oder `papierkorb`, Gmail braucht `papierkorb`). Setzbar mit `plugin_wert_setzen`.
- `passwoerter` (Pflicht, geheim): JSON-Objekt Kontoname auf Passwort, Google mit App-Passwort. Nur das Fenster trägt es ein (Schlüsselbund). Ein Parsefehler nennt nie einen Teil des Werts.
- `triage_an` (Standard aus), `triage_takt_min` (Standard 10): Mail-Triage im Takt, siehe "Takt und Aktionen".
- `signatur_html`, `signatur_text`: Signatur für Entwürfe. `signatur_text` allein genügt (HTML wird daraus gebaut), mit `signatur_html` dient `signatur_text` als Textteil. Beide leer: kein Gruß.

Beispiel `konten` (ohne Zugangsdaten):

```json
[
  { "name": "mailcow", "host": "mail.robinherbeck.com", "benutzer": "robin@example.test" },
  { "name": "google", "host": "imap.gmail.com", "benutzer": "robin@example.test", "loeschen": "papierkorb" }
]
```

## Rechte

- lesen und schreiben: `haupt` (Quelle für Anhänge eines Entwurfs, Ziel für `anhang_speichern` und `als_pdf`, nie versteckte Teile wie `.env` oder `.git`)
- Netz: `mail.robinherbeck.com`, `imap.gmail.com` (der Leitstand kennt nur Ja oder Nein, keine Host-Trennung je Konto)
- Daten: `daten/` im Plugin-Ordner (UIDNEXT-Stand je Konto, Triage-Merkliste), nicht im Repo. Bei einem Update bleibt der alte Stand als `<name>.alt`, der Wächter setzt dann eine Basis ohne Zählung.

Die Lesegrenze der Rolle (Sandbox je Rolle) gibt es im Plugin nicht: es gilt allein `haupt`.

## Bauen und testen

Der Leitstand startet `dist/server.js`, ein Git-Stand hat kein `node_modules`. Darum ist das Bundle eingecheckt und wird nach jeder Änderung neu gebaut:

```
bun install
bun run bau        # bun build --target bun server.ts --outfile dist/server.js
bun run typecheck
bun test
```

Das Bundle hält ein Test aktuell, kein Git-Hook. Das Repo setzt bewusst keinen Git-Config-Wert (`core.hooksPath` und Ähnliches): `git_push` des Leitstands lehnt ein Repo mit diesem Wert ab, und `bun install` führt kein Skript aus.

- `test/dist.test.ts` baut in einen Temp-Ordner und vergleicht mit `dist/server.js`. Rot heißt "dist ist veraltet, bun run bau". Der Bau ist deterministisch bis auf den absoluten Checkout-Pfad in zwei `__dirname`-Zeilen (pino, thread-stream), den der Test vor dem Vergleich ausblendet. Ein Commit aus einem anderen Ordner ändert diese zwei Zeilen im Bundle, das ist erwartet.

## Namenskollision

Der Name `mail` ist im Leitstand das feste Modul. Ein Plugin mit diesem Namen lässt sich erst aufnehmen, wenn das feste Modul entfernt ist.
