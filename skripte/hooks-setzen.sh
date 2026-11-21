#!/bin/sh
# Läuft als "prepare" bei bun install: zeigt core.hooksPath dieses Klons auf .githooks.
# Nur die Git-Konfiguration dieses Repos, nie die globale. Ohne Git-Ordner (Tarball) passiert nichts.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git config core.hooksPath .githooks || echo "hooks-setzen: core.hooksPath nicht gesetzt (Git-Konfiguration nicht beschreibbar), Hook übersprungen" >&2
exit 0
