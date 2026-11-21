# Changelog

- Unveröffentlicht: `test/dist.test.ts` baut den Quelltext in einen Temp-Ordner und vergleicht mit `dist/server.js` ("dist ist veraltet, bun run bau"). Pre-commit-Hook `.githooks/pre-commit` baut und nimmt `dist/server.js` mit, `bun install` setzt ihn per `prepare` (nur lokales `core.hooksPath`) (A-2310).

- 1.2.3: `signatur_text` allein gilt als Signatur. Vorher gab `leseSignatur` ohne `signatur_html` nichts zurück und der Entwurf hatte keinen Gruß (A-2307).
- 1.2.2: Die `beschreibung` in der plugin.yml war mit über 400 Zeichen zu lang, der Kern lehnte das Plugin ab (A-2292). Sie ist gekürzt, ebenso der Titel der Einstellung `konten` (höchstens 80). `test/pluginyml.test.ts` prüft jetzt alle Grenzen des Kerns (`server/module/plugin-yml.ts`) und nicht nur das Parsen.
- 1.2.1: Die plugin.yml parst wieder: in `beschreibung` stand ein ungequotetes ": " ("für den Kern: neue Mails"), das bricht einen Block-Skalar (`Bun.YAML.parse`: Unexpected token), der Kern lehnte das Plugin ab. `beschreibung` und die Werkzeugtexte stehen jetzt in Anführungszeichen. Neuer Test `test/pluginyml.test.ts` liest die Datei mit demselben Parser.
- 1.2.0: Fünf Lesewerkzeuge für den Leitstand-Kern: `neue_seit`, `nachhol_zaehle`, `entwurf_finde`, `gesendet_finde`, `konto_pruefe`, alle mit `structuredContent` nach dem Vertrag des Kerns. Das Ereignis `mail.neu` trägt zusätzlich `daten: { konto, neu, gesendet }` (A-2294).
- 1.1.0: Rollenregel `rules/mail.md` im Plugin (`rules:` in der plugin.yml). `posteingang`, `suchen` und `entwuerfe_liste` liefern zusätzlich `structuredContent` mit Konto, Ordner, UID, Message-ID, Betreff, Von, An, Cc, Datum, Flags, In-Reply-To und References (A-2290).
- 1.0.0: Erste Fassung als Plugin (vorher festes Gateway-Modul und Wächter im Kern, A-2282): 11 Werkzeuge, Postfach-Wächter als Dauerprozess, Ereignis `mail.neu`.
