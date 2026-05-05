# Canon PowerShot G7 X Mark III — Tracker

Automatische prijs- en voorraadtracker voor de **Canon PowerShot G7 X Mark III** bij fotozaken en elektronicaketens in Nederland, België en Duitsland.

Deze repo wordt elke 4 uur bijgewerkt door een Claude Code routine die:
- Alle bekende winkels bezoekt en prijs/voorraad/levertijd ophaalt
- Nieuwe winkels zoekt en toevoegt
- `g7x-tracker.md` en `g7x-tracker.html` bijwerkt
- Een snapshot wegschrijft naar `history/<UTC-timestamp>.md`

## Live overzicht

Zodra GitHub Pages is geactiveerd: **https://robertinoblagrove.github.io/CanonPowershot/**

## Bestanden

- `g7x-tracker.md` — markdown overzicht (laatste run)
- `g7x-tracker.html` — standalone HTML pagina
- `index.html` — Pages root (kopie van g7x-tracker.html)
- `history/` — snapshots per run

## Pages activeren (eenmalig)

1. Repo Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: `main` → `/ (root)` → Save
4. Wacht ~1 minuut, dan is de live URL bereikbaar

## Routine beheer

https://claude.ai/code/routines/trig_014zsC8CNKBB1L2GBCqgc3U4
