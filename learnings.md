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

## Run 2026-05-08T20:43Z (handmatige verificatie door user)

### KRITIEKE BUG: JSON-LD InStock = onbetrouwbaar voor de G7X Mark III
De JSON-LD `availability: "InStock"` claim is bij meerdere shops onjuist — de zichtbare pagina toont expliciet "Tijdelijk uitverkocht" / "Later leverbaar" / "Niet leverbaar" terwijl JSON-LD InStock blijft.

**Bevestigde foutpositieven (8 mei 2026, geverifieerd door user-screenshot of WebFetch)**:
- **NEBO** (neboweb.nl): JSON-LD = InStock, visuele badge = "Tijdelijk uitverkocht". Echte status: ❌
- **Cameranu (Black)** (cameranu.nl): JSON-LD InStock, "Later leverbaar" + knop "Reserveer nu" + tooltip "Dit product is tijdelijk uitverkocht". Echte status: ❌
- **Calumet DE (Black)** (calumet.de — domein gewijzigd van calumetphoto.de): JSON-LD = preorder/InStock, pagina toont "Bald wieder lieferbar — 3-6 Monate Lieferzeit". Echte status: ❌
- **Calumet DE (Silver)**: zelfde issue.
- **FotoMeyer**: meta-tag price OK, maar pagina toont "LIEFERTERMIN OFFEN — aktuell kann uns der Hersteller keinen Liefertermin nennen". Echte status: ❌

### Fix-opdracht voor scrape.mjs (volgende run)
Voor elke shop, **na** JSON-LD parse, doe een tweede check op zichtbare badges/teksten **VOORDAT** je de InStock claim accepteert:

```js
const OUT_OF_STOCK_BADGES = [
  // NL
  /tijdelijk\s+uitverkocht/i,
  /later\s+leverbaar/i,
  /niet\s+(meer\s+)?leverbaar/i,
  /uitverkocht/i,
  /reserveer\s+nu/i,            // Cameranu pattern
  /op\s+wachtlijst/i,
  /momenteel\s+niet\s+(in\s+stock|leverbaar)/i,
  /houd\s+mij\s+op\s+de\s+hoogte/i,
  // DE
  /nicht\s+lieferbar/i,
  /ausverkauft/i,
  /bald\s+wieder\s+lieferbar/i,
  /liefertermin\s+offen/i,
  /derzeit\s+nicht\s+verfügbar/i,
  // FR/EN fallbacks
  /sold\s+out/i,
  /out\s+of\s+stock/i,
  /épuisé/i,
];
// Als ANY van deze patterns matched in de page body, override JSON-LD InStock → OutOfStock
```

### Domein-correcties
- **Calumet DE**: `calumetphoto.de` redirect (301) → `calumet.de`. Update shop-registry URLs.
- **Foto Konijnenberg silver-page** redirect (301) naar Kamera Express homepage = product weggehaald. Markeer als `discontinued`.

### Scrape-blockers (status onveranderd, geen fix mogelijk via headless Chromium)
- Cameranu, Canon NL Store, Canon DE Store, Saturn DE, Krëfel BE, Kamera Express NL: HTTP 403 (Akamai/Cloudflare). Voor deze shops moet de bot vertrouwen op WebSearch snippets + handmatige verificatie van URL-validity.

### Nieuwe winkels toegevoegd 8 mei 2026
- **Cameraland.nl** (NL) — Black body €999, Silver €1099, Outlet €999. Allen ❌. https://www.cameraland.nl/
- **Foto Grobet BE** (BE) — Black/Silver €939. ❌ wachtlijst. https://www.grobet.be/
- **Digimaxx** (NL, Dordrecht) — Black/Silver €999. ❓ levertijd onbekend. https://digimaxx.nl/
- **Cameradeals.nl** (NL, vergelijker) — list aggregator. https://www.cameradeals.nl/
- **Kaufland.de** (DE) — €984,50. ❓ scrape geblokt. https://www.kaufland.de/

### Marktinzicht
De Canon G7X Mark III is per mei 2026 **breed uitverkocht** in NL/BE/DE. Geen enkele winkel in het volledige getrackte bestand had bij manuele verificatie (8 mei) bevestigde voorraad. Realistisch verwachten:
- Wachtlijsten van weken tot 6 maanden
- Sporadische voorraad bij refurbished-aanbieders (MPB, MyPB, fotostudio's)
- Tweedehands beter te vinden via Marktplaats/2dehands/eBay

Volgende runs: focus op **refurbished** en **tweedehands** kanalen — zij hebben wel voorraad. Voorbeelden om toe te voegen: MPB.com (NL/EU), CameraJungle, Kamera Express Tweedehands sectie.

