# Tracker Learnings (append-only)

## Run 2026-05-05T20:59Z (vorige run, voor switch naar Playwright)

- Methode was WebSearch + WebFetch — vrijwel alle retailers blokten WebFetch met HTTP 403.
- Data kwam uit search-snippets, niet uit echte page-loads.
- Vanaf deze run: Playwright met Chromium voor echte browser-fingerprint.
- Geverifieerde productvarianten: Black body, Silver body, Vlogger Kit, Battery Kit, Streaming Kit, Premium Vlog Kit, 30th Anniversary Limited Edition (graphite), Used/Refurbished.
- 30th Anniversary Edition gelanceerd op 2026-04-23 — Canon DE noemt €899.
- Foka.nl is gefuseerd met Kamera Express (oude URL redirect).
- Foto Brenner: juiste domein is fotobrenner.de (niet foto-brenner.de).
- Schaarste in 2026: Canon kondigde productieverhoging van 50% aan; veel "uitverkocht"-vermeldingen.

## Run 2026-05-06T10:29Z (eerste Playwright-run, sandbox aside)

### Werkte goed (bron stabiel)
- **JSON-LD** gaf prijs én voorraad bij: Coolblue NL, Foto de Vakman, NEBO, melskensvenray, Coolblue BE, Calumet DE, FNAC België.
- **meta-tag** werkte op: FotoMeyer.
- **Heuristiek** werkte voor: MediaMarkt NL/DE/BE (visible price-element), Amazon NL/DE/BE, Bol.com, Vanden Borre, Foto Erhardt — maar levert vaak ook *junk* prijzen (review-counts, kortings-percentages, gerelateerde producten). build-output.mjs filtert nu prijzen <€400 en >€2500 voor heuristiek.

### Hardnekkig geblokkeerd
- **Cameranu, Canon NL, FNAC BE, Saturn DE, Canon DE Store**: HTTP 403 (Cloudflare/Akamai bot-detectie tegen headless Chromium).
- **Krëfel BE**: HTTP 500 (server error of bot-detectie).
- **BCC.nl, Foto Mundus, Foto Brenner**: HTTP 404 — URLs zijn stale en moeten via web_search opnieuw gevonden worden in volgende run.

### Te fixen volgende run
- **Krëfel** (BE): per-shop scrape-hint nodig; pagina rendert prijs in een container die de heuristiek mist.
- **Vanden Borre** (BE) levert prijs maar geen voorraad-status; voorraad-detectie in NL/FR-tekst regex uitbreiden.
- **Heuristiek** regex moet €-symbool of duizendtal-formaat verplichten om "20", "99", "15" e.d. te filteren in plaats van post-hoc weggooien (zorgt voor snellere convergentie).
- **Saturn = MediaMarkt** (zelfde infrastructuur) — als MediaMarkt werkt en Saturn niet, is dat raar; mogelijk speelt geo of A/B-test mee.
- **Stale URLs** (BCC, Foto Mundus, Foto Brenner): web_search met `site:<domein> "G7X Mark III"` om nieuwe productpagina's te vinden.

### Nieuwe winkels deze run
- Geen — eerste run focust op stabiliseren van de starterlijst-URLs uit vorige run. Zoekquery's volgen in volgende iteratie.

### Data-betrouwbaarheid
- 56 winkels gescraped; 38 met prijs (na sanity-filter); 10 hard-bevestigd op voorraad (JSON-LD of heuristiek + prijs in zinvol bereik); 15 expliciet uit-voorraad; 20 onbekend.
- Cheapest hard-confirmed: **Amazon DE Black €789,00** (heuristiek; mogelijk niet de body-only — needs verification next run).

