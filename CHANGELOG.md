# Changelog

- 1.2.0: Fünf Lesewerkzeuge für den Leitstand-Kern: `neue_seit`, `nachhol_zaehle`, `entwurf_finde`, `gesendet_finde`, `konto_pruefe`, alle mit `structuredContent` nach dem Vertrag des Kerns. Das Ereignis `mail.neu` trägt zusätzlich `daten: { konto, neu, gesendet }` (A-2294).
- 1.1.0: Rollenregel `rules/mail.md` im Plugin (`rules:` in der plugin.yml). `posteingang`, `suchen` und `entwuerfe_liste` liefern zusätzlich `structuredContent` mit Konto, Ordner, UID, Message-ID, Betreff, Von, An, Cc, Datum, Flags, In-Reply-To und References (A-2290).
- 1.0.0: Erste Fassung als Plugin (vorher festes Gateway-Modul und Wächter im Kern, A-2282): 11 Werkzeuge, Postfach-Wächter als Dauerprozess, Ereignis `mail.neu`.
