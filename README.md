# mail

Mail über IMAP als Plugin des Leitstands: lesen, suchen, Entwürfe anlegen, ändern und verschieben, dazu der Postfach-Wächter, der neue Mails als Ereignis `mail.neu` meldet. Versenden gibt es nicht, kein SMTP, kein Transport: Entwürfe landen im Entwürfe-Ordner, Robin schickt sie selbst ab. Eigenes Repo, importiert nichts aus dem Leitstand. Entscheidungen im Leitstand-Repo: ADR 0038 (Plugins), 0042 (Ereignis-Kanal), 0043 (Dauerprozess).

## Werkzeuge

Das Gateway stellt `mail_` voran, im Plugin heißen sie ohne Präfix.

- lesend (`stufe: frei`): `posteingang`, `suchen`, `lesen`, `entwuerfe_liste`
- schreibend, `stufe: frei`: `entwurf_neu`, `antwort_entwurf`, `entwurf_aendern`, `entwurf_loeschen`, `verschieben`, `triage_merke`
- schreibend, `stufe: karte`: `anhang_speichern` (schreibt eine Datei aus einer fremden Mail auf die Platte)

Die Stufen sind der Vorschlag aus dem bisherigen Gateway-Modul (10 frei, 1 Karte). Bei Aufnahme und Update zeigt die Karte sie, Robin bestätigt oder ändert sie.

## Dauerprozess und Ereignis

`dauer: true`: das Gateway startet den Prozess beim Laden und hält ihn am Leben (Neustart mit Backoff, siehe `docs/plugin-vorlage.md` im Leitstand-Repo). Der Wächter hält je Konto eine IMAP-Verbindung mit IDLE auf INBOX und sieht den Gesendet-Ordner im Takt nach. Gezählt wird über UIDNEXT, eine Lücke nach einem Abbruch oder Neustart zählt genau einmal, ein Wechsel der UIDVALIDITY setzt eine neue Basis ohne Zählung.

Gemeldet wird die MCP-Notification `notifications/leitstand/ereignis` mit `art: mail.neu` und einem Text aus Kontoname und Zahlen (`privat: 2 neu, 1 gesendet`). Nie Betreff, Adresse oder Inhalt. Zählstände und die Nachholzählung bleiben im Kern.

## Einstellungen

- `konten` (Pflicht): JSON-Liste, je Eintrag `name`, `host`, `benutzer`, optional `port` (993), `adresse`, `anzeigename`, `loeschen` (`expunge` oder `papierkorb`, Gmail braucht `papierkorb`). Setzbar mit `plugin_wert_setzen`.
- `passwoerter` (Pflicht, geheim): JSON-Objekt Kontoname auf Passwort, Google mit App-Passwort. Nur das Fenster trägt es ein (Schlüsselbund). Ein Parsefehler nennt nie einen Teil des Werts.
- `signatur_html`, `signatur_text`: Signatur für Entwürfe.

Beispiel `konten` (ohne Zugangsdaten):

```json
[
  { "name": "mailcow", "host": "mail.robinherbeck.com", "benutzer": "robin@example.test" },
  { "name": "google", "host": "imap.gmail.com", "benutzer": "robin@example.test", "loeschen": "papierkorb" }
]
```

## Rechte

- lesen und schreiben: `haupt` (Quelle für Anhänge eines Entwurfs, Ziel für `anhang_speichern`, nie versteckte Teile wie `.env` oder `.git`)
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

## Namenskollision

Der Name `mail` ist im Leitstand das feste Modul. Ein Plugin mit diesem Namen lässt sich erst aufnehmen, wenn das feste Modul entfernt ist.
