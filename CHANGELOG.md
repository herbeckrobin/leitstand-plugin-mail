# Changelog

- 1.2.1: Die plugin.yml parst wieder: in `beschreibung` stand ein ungequotetes ": " ("für den Kern: neue Mails"), das bricht einen Block-Skalar (`Bun.YAML.parse`: Unexpected token), der Kern lehnte das Plugin ab. `beschreibung` und die Werkzeugtexte stehen jetzt in Anführungszeichen. Neuer Test `test/pluginyml.test.ts` liest die Datei mit demselben Parser.
- 1.2.0: Fünf Lesewerkzeuge für den Leitstand-Kern: `neue_seit`, `nachhol_zaehle`, `entwurf_finde`, `gesendet_finde`, `konto_pruefe`, alle mit `structuredContent` nach dem Vertrag des Kerns. Das Ereignis `mail.neu` trägt zusätzlich `daten: { konto, neu, gesendet }` (A-2294).
- 1.1.0: Rollenregel `rules/mail.md` im Plugin (`rules:` in der plugin.yml). `posteingang`, `suchen` und `entwuerfe_liste` liefern zusätzlich `structuredContent` mit Konto, Ordner, UID, Message-ID, Betreff, Von, An, Cc, Datum, Flags, In-Reply-To und References (A-2290).
- 1.0.0: Erste Fassung als Plugin (vorher festes Gateway-Modul und Wächter im Kern, A-2282): 11 Werkzeuge, Postfach-Wächter als Dauerprozess, Ereignis `mail.neu`.
