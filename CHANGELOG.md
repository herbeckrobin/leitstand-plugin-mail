# Changelog

- 1.1.0: Rollenregel `rules/mail.md` im Plugin (`rules:` in der plugin.yml). `posteingang`, `suchen` und `entwuerfe_liste` liefern zusätzlich `structuredContent` mit Konto, Ordner, UID, Message-ID, Betreff, Von, An, Cc, Datum, Flags, In-Reply-To und References (A-2290).
- 1.0.0: Erste Fassung als Plugin (vorher festes Gateway-Modul und Wächter im Kern, A-2282): 11 Werkzeuge, Postfach-Wächter als Dauerprozess, Ereignis `mail.neu`.
