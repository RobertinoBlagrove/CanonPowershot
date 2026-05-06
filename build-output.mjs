import fs from 'fs';
import { execSync } from 'child_process';

const results = JSON.parse(fs.readFileSync('scrape-results.json', 'utf8'));
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const NOW_FMT_UTC = NOW_ISO.replace('T', ' ').slice(0, 16) + ' UTC';
const NOW_AMS = NOW.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'long', timeStyle: 'short' });

// ── PRICE NORMALIZATION ────────────────────────────────────────────
const parsePrice = (raw) => {
  if (raw == null) return null;
  let s = String(raw).replace(/ /g, ' ').trim();
  s = s.replace(/[€$£]/g, '').trim();
  // "1.099,00" → 1099.00 ; "1,099.00" → 1099.00 ; "879" → 879 ; "879,00" → 879
  if (/,\d{2}$/.test(s) && /\./.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{2}$/.test(s)) {
    s = s.replace(',', '.');
  } else if (/\.\d{3}/.test(s) && !/,\d{2}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};
const fmtPrice = (n) => n == null ? '❓' : '€' + n.toFixed(2).replace('.', ',');

const stockIcon = (s) => s === 'in_stock' ? '✅' : s === 'out_of_stock' ? '❌' : s === 'preorder' ? '🟡' : '❓';
const sourceLabel = (s) => ({
  'json-ld': 'direct (JSON-LD)',
  'meta-tag': 'direct (meta)',
  'custom-selector': 'direct (custom)',
  'heuristic': 'heuristiek'
})[s] || s || '—';

// ── PRICE SANITY (G7X Mark III is €600-€1500 typical) ─────────────
// Heuristic-source prices outside €600-€1800 zijn vrijwel altijd accessoire-prijzen
// uit "Vaak samen gekocht" / "Gerelateerde producten" secties op marketplace-pagina's.
// JSON-LD/meta-tag is betrouwbaarder maar ook daar bound op realistisch range.
const HEUR_MIN = 600;
const HEUR_MAX = 1800;
const STRUCT_MIN = 500;
const STRUCT_MAX = 2500;
const looksSane = (n, source) => {
  if (n == null) return false;
  if (source === 'json-ld' || source === 'meta-tag' || source === 'custom-selector') {
    return n >= STRUCT_MIN && n <= STRUCT_MAX;
  }
  return n >= HEUR_MIN && n <= HEUR_MAX;
};

// ── ENRICH RESULTS ─────────────────────────────────────────────────
const isAmazonUrl = (u) => /amazon\./i.test(u || '');
const enriched = results.map(r => {
  const rawNum = parsePrice(r.price);
  const sane = looksSane(rawNum, r.source);
  // Amazon: wantrouwen — heuristiek-data is daar niet betrouwbaar
  const amazonFlaky = isAmazonUrl(r.url) && r.source === 'heuristic';
  const priceNum = sane && !amazonFlaky ? rawNum : null;
  // Amazon stock detection ook niet vertrouwen tenzij json-ld
  const stockTrust = isAmazonUrl(r.url) && r.source !== 'json-ld' ? 'unknown' : r.stock;
  return {
    ...r,
    price_raw: r.price,
    price_num: priceNum,
    price_display: fmtPrice(priceNum),
    price_rejected: rawNum != null && !sane ? rawNum : null,
    stock: stockTrust,
    stock_original: r.stock,
    stock_icon: stockIcon(stockTrust),
    source_label: sourceLabel(r.source) + (amazonFlaky ? ' (Amazon-heuristiek, niet vertrouwd)' : ''),
    bot_blocked: isAmazonUrl(r.url) && (r.source === 'heuristic' || r.source === null),
    // Variant flag onbetrouwbaar voor existing data (regex op body text); URL-context is sterker
    // Voor nu: alleen op verified_mark_iii vertrouwen voor summary-inclusion
    valid_for_summary: r.verified_mark_iii !== false
  };
});

const byCountry = { NL: [], BE: [], DE: [], FR: [] };
for (const r of enriched) {
  if (byCountry[r.country]) byCountry[r.country].push(r);
}
for (const c of Object.keys(byCountry)) {
  byCountry[c].sort((a, b) => {
    if (a.price_num != null && b.price_num != null) return a.price_num - b.price_num;
    if (a.price_num != null) return -1;
    if (b.price_num != null) return 1;
    return a.shop.localeCompare(b.shop);
  });
}

// ── SUMMARY ───────────────────────────────────────────────────────
const total = enriched.length;
const inStockHard = enriched.filter(r => r.stock === 'in_stock' && r.price_num && r.valid_for_summary).length;
const outStock = enriched.filter(r => r.stock === 'out_of_stock').length;
const unknown = enriched.filter(r => r.stock === 'unknown').length;

// Amazon serveert een gestripte pagina aan headless Chromium — alle "prijzen"
// die we van Amazon halen zijn heuristiek-junk (gerelateerde producten/accessoires).
// Tot we echte stealth-setup hebben (playwright-extra met stealth plugin),
// vertrouwen we Amazon-data niet voor cheapest-overall berekeningen.
const isAmazon = (r) => /amazon\./i.test(r.url || '');
const cheapestOverall = enriched
  .filter(r => r.stock === 'in_stock' && r.price_num && r.valid_for_summary && !isAmazon(r))
  .sort((a, b) => a.price_num - b.price_num)[0];

const cheapestByCountry = {};
for (const c of ['NL', 'BE', 'DE', 'FR']) {
  cheapestByCountry[c] = byCountry[c]
    .filter(r => r.stock === 'in_stock' && r.price_num && r.valid_for_summary && !isAmazon(r))
    .sort((a, b) => a.price_num - b.price_num)[0];
}

// Diff with previous run (if g7x-tracker.md exists)
let prevMD = '';
try { prevMD = fs.readFileSync('g7x-tracker.md', 'utf8'); } catch {}

// ── MARKDOWN OUTPUT ───────────────────────────────────────────────
const mdTable = (rows) => {
  const header = '| Winkel | Prijs | Voorraad | Levertijd | Variant | Bron | Link |\n|--------|------:|----------|-----------|---------|------|------|';
  const body = rows.map(r => {
    const linkText = r.error ? `error: ${r.error}` : 'productpagina';
    return `| ${r.shop} | ${r.price_display} | ${r.stock_icon} | ${r.delivery || '❓'} | ${r.variant_label || r.variant || '—'} | ${r.source_label} | [${linkText}](${r.url}) |`;
  }).join('\n');
  return rows.length ? header + '\n' + body : '_(geen winkels)_';
};

const md = `# Canon PowerShot G7 X Mark III — Tracker

_Laatst bijgewerkt: ${NOW_ISO}_
_Live: https://robertinoblagrove.github.io/CanonPowershot/_

## Samenvatting

- **Totaal winkels gecheckt**: ${total}
- **Hard-bevestigd op voorraad (directe scrape, body/kit alleen)**: ${inStockHard}
- **Uit voorraad ❌**: ${outStock}
- **Niet vaststelbaar ❓**: ${unknown}
- **Goedkoopste op voorraad (overall)**: ${cheapestOverall ? `${cheapestOverall.shop} — ${cheapestOverall.price_display} ([link](${cheapestOverall.url}))` : '❓ geen enkele directe-scrape met prijs én voorraad'}
- **Goedkoopste in NL**: ${cheapestByCountry.NL ? `${cheapestByCountry.NL.shop} — ${cheapestByCountry.NL.price_display}` : '❓'}
- **Goedkoopste in BE**: ${cheapestByCountry.BE ? `${cheapestByCountry.BE.shop} — ${cheapestByCountry.BE.price_display}` : '❓'}
- **Goedkoopste in DE**: ${cheapestByCountry.DE ? `${cheapestByCountry.DE.shop} — ${cheapestByCountry.DE.price_display}` : '❓'}
- **Goedkoopste in FR** (kan naar NL leveren): ${cheapestByCountry.FR ? `${cheapestByCountry.FR.shop} — ${cheapestByCountry.FR.price_display}` : '❓'}

## Nederland

${mdTable(byCountry.NL)}

## België

${mdTable(byCountry.BE)}

## Duitsland

${mdTable(byCountry.DE)}

## Frankrijk (kan leveren naar NL)

${mdTable(byCountry.FR)}

## Run-log

### Run ${NOW_FMT_UTC}

- ${total} winkels gecheckt; ${enriched.filter(r => r.price_num).length} met directe prijs uit Playwright-scrape
- Bron-verdeling: ${(() => {
    const counts = {};
    for (const r of enriched) {
      const k = r.source || (r.error ? 'error' : 'no-data');
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k}: ${v}`).join(', ');
  })()}
- Geblokkeerde shops (consecutive_fails ≥ 3): ${(() => {
    const cache = JSON.parse(fs.readFileSync('fetch-cache.json', 'utf8') || '{}');
    const blocked = Object.entries(cache).filter(([_, v]) => v.consecutive_fails >= 3).map(([k]) => k);
    return blocked.length ? blocked.join(', ') : 'geen';
  })()}
`;

fs.writeFileSync('g7x-tracker.md', md);

// ── HTML OUTPUT (cache-busting + age indicator) ───────────────────
const htmlTable = (rows) => {
  if (!rows.length) return '<p><em>geen winkels</em></p>';
  const head = `<table class="shops">
    <thead><tr><th data-sort="shop">Winkel</th><th data-sort="price">Prijs</th><th data-sort="stock">Voorraad</th><th>Levertijd</th><th>Variant</th><th>Bron</th><th>Link</th></tr></thead><tbody>`;
  const body = rows.map(r => {
    const stockClass = r.stock === 'in_stock' ? 'stock-in' : r.stock === 'out_of_stock' ? 'stock-out' : 'stock-unknown';
    const sourceClass = r.source === 'json-ld' || r.source === 'meta-tag' || r.source === 'custom-selector'
      ? 'src-direct' : r.source === 'heuristic' ? 'src-heuristic' : 'src-other';
    return `<tr data-stock="${r.stock}" data-variant="${r.variant || ''}" data-price="${r.price_num ?? ''}">
      <td>${escapeHtml(r.shop)}</td>
      <td class="price">${r.price_display}</td>
      <td><span class="badge ${stockClass}">${r.stock_icon}</span></td>
      <td>${escapeHtml(r.delivery || '—')}</td>
      <td>${escapeHtml(r.variant_label || r.variant || '—')}</td>
      <td><span class="badge ${sourceClass}">${escapeHtml(r.source_label)}</span></td>
      <td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">↗</a></td>
    </tr>`;
  }).join('\n');
  return head + body + '</tbody></table>';
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let commitHash = 'unknown';
try { commitHash = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}

const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="pragma" content="no-cache">
<meta http-equiv="expires" content="0">
<meta name="last-updated" content="${NOW_ISO}">
<title>Canon G7X Tracker — ${NOW_FMT_UTC}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         margin: 0; padding: 0; background: #f7f7f8; color: #111; }
  header { background: #111; color: #fff; padding: 24px 32px; }
  h1 { margin: 0 0 4px 0; font-size: 24px; font-weight: 600; }
  header .sub { color: #aaa; font-size: 14px; }
  main { max-width: 1280px; margin: 0 auto; padding: 24px 32px; }
  .freshness { background: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;
               box-shadow: 0 1px 3px rgba(0,0,0,0.08); display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .freshness .ts { font-size: 14px; color: #555; }
  .age-badge { padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 14px; display: inline-block; }
  .age-badge.fresh { background: #d1fae5; color: #065f46; }
  .age-badge.aging { background: #fef3c7; color: #92400e; }
  .age-badge.stale { background: #fee2e2; color: #991b1b; }
  .stale-warn { color: #991b1b; font-size: 13px; margin-top: 8px; flex-basis: 100%; display: none; }
  .age-badge.stale ~ .stale-warn { display: block; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat { background: #fff; padding: 18px 20px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .stat .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .stat .sub { font-size: 13px; color: #666; margin-top: 4px; }
  .filters { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters button { background: #fff; border: 1px solid #ddd; padding: 6px 14px; border-radius: 999px;
                    font-size: 13px; cursor: pointer; }
  .filters button.active { background: #111; color: #fff; border-color: #111; }
  h2.country { margin-top: 28px; font-size: 18px; }
  table.shops { width: 100%; background: #fff; border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border-radius: 8px; overflow: hidden; }
  table.shops th { text-align: left; padding: 10px 12px; background: #fafafa; font-weight: 600; font-size: 12px;
                   text-transform: uppercase; color: #555; border-bottom: 1px solid #eee; cursor: pointer; user-select: none; }
  table.shops td { padding: 10px 12px; border-bottom: 1px solid #f2f2f2; font-size: 14px; vertical-align: middle; }
  table.shops td.price { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  table.shops tr:hover td { background: #fafafa; }
  table.shops tr[data-stock="hidden"] { display: none; }
  .badge { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; display: inline-block; }
  .badge.stock-in { background: #d1fae5; color: #065f46; }
  .badge.stock-out { background: #fee2e2; color: #991b1b; }
  .badge.stock-unknown { background: #f3f4f6; color: #555; }
  .badge.src-direct { background: #dbeafe; color: #1e40af; }
  .badge.src-heuristic { background: #fef3c7; color: #92400e; }
  .badge.src-other { background: #f3f4f6; color: #555; }
  footer { margin-top: 48px; padding: 24px 32px; background: #111; color: #aaa; font-size: 13px; }
  footer a { color: #ddd; }
  @media (max-width: 768px) {
    main { padding: 16px; }
    table.shops { font-size: 12px; }
    table.shops td, table.shops th { padding: 6px 8px; }
  }
</style>
</head>
<body>
<header>
  <h1>Canon PowerShot G7 X Mark III — Tracker</h1>
  <div class="sub">Voorraad &amp; prijs in NL · BE · DE · auto-update via Mac mini /loop</div>
</header>

<main>
  <div class="freshness">
    <div>
      <div class="ts"><strong>Run-tijd:</strong> ${NOW_AMS} (Europe/Amsterdam) · <code>${NOW_FMT_UTC}</code></div>
    </div>
    <div>
      <span class="age-badge fresh" id="age-indicator">net bijgewerkt</span>
    </div>
    <div class="stale-warn">⚠️ De Mac mini heeft deze pagina al meer dan 72 uur niet ververst. Check of de /loop nog draait.</div>
  </div>

  <section class="summary">
    <div class="stat"><div class="label">Totaal winkels</div><div class="value">${total}</div></div>
    <div class="stat"><div class="label">Hard op voorraad ✅</div><div class="value">${inStockHard}</div><div class="sub">directe scrape met prijs + voorraad</div></div>
    <div class="stat"><div class="label">Uit voorraad ❌</div><div class="value">${outStock}</div></div>
    <div class="stat"><div class="label">Niet vaststelbaar ❓</div><div class="value">${unknown}</div></div>
    <div class="stat"><div class="label">Goedkoopste op voorraad</div>
      <div class="value">${cheapestOverall ? cheapestOverall.price_display : '❓'}</div>
      <div class="sub">${cheapestOverall ? escapeHtml(cheapestOverall.shop) : 'geen confirmed op-voorraad-shop'}</div>
    </div>
  </section>

  <div class="filters">
    <button class="active" data-filter="all">Alle</button>
    <button data-filter="in_stock">Alleen op voorraad ✅</button>
    <button data-filter="body">Alleen body</button>
  </div>

  <h2 class="country">🇳🇱 Nederland (${byCountry.NL.length})</h2>
  ${htmlTable(byCountry.NL)}

  <h2 class="country">🇧🇪 België (${byCountry.BE.length})</h2>
  ${htmlTable(byCountry.BE)}

  <h2 class="country">🇩🇪 Duitsland (${byCountry.DE.length})</h2>
  ${htmlTable(byCountry.DE)}

  <h2 class="country">🇫🇷 Frankrijk (${byCountry.FR.length}) <small style="font-size: 13px; color: #666; font-weight: 400;">— levert ook naar NL</small></h2>
  ${htmlTable(byCountry.FR)}
</main>

<footer>
  Commit <a href="https://github.com/RobertinoBlagrove/CanonPowershot/commit/${commitHash}"><code>${commitHash}</code></a> ·
  Bron: <a href="https://github.com/RobertinoBlagrove/CanonPowershot">RobertinoBlagrove/CanonPowershot</a> ·
  Hard-refresh: <kbd>Cmd+Shift+R</kbd> (Mac) / <kbd>Ctrl+Shift+R</kbd> (Windows)
  <br><br>
  Deze pagina ververst zichzelf bij elke run van de Mac mini /loop. De versheid-indicator hierboven werkt client-side en updatet elke 30 seconden.
</footer>

<script>
  const RUN_TIMESTAMP = '${NOW_ISO}';
  function updateAge() {
    const ageMs = Date.now() - new Date(RUN_TIMESTAMP).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const ageHr  = Math.floor(ageMin / 60);
    const ageDay = Math.floor(ageHr / 24);
    let txt, cls;
    if (ageMin < 1)       { txt = 'net bijgewerkt';            cls = 'fresh'; }
    else if (ageMin < 60) { txt = ageMin + ' min geleden';     cls = 'fresh'; }
    else if (ageHr  < 24) { txt = ageHr  + ' uur geleden';     cls = 'fresh'; }
    else if (ageHr  < 72) { txt = ageDay + ' dag(en) geleden'; cls = 'aging'; }
    else                  { txt = ageDay + ' dagen geleden';   cls = 'stale'; }
    const el = document.getElementById('age-indicator');
    if (el) { el.textContent = txt; el.className = 'age-badge ' + cls; }
  }
  updateAge();
  setInterval(updateAge, 30000);

  // Filters
  document.querySelectorAll('.filters button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filters button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const f = b.dataset.filter;
      document.querySelectorAll('table.shops tbody tr').forEach(tr => {
        let hide = false;
        if (f === 'in_stock' && tr.dataset.stock !== 'in_stock') hide = true;
        if (f === 'body'     && tr.dataset.variant !== 'body')   hide = true;
        tr.style.display = hide ? 'none' : '';
      });
    });
  });

  // Sortable headers (basic)
  document.querySelectorAll('table.shops th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const tbody = th.closest('table').querySelector('tbody');
      const rows = [...tbody.querySelectorAll('tr')];
      const key = th.dataset.sort;
      rows.sort((a, b) => {
        if (key === 'price') {
          const av = parseFloat(a.dataset.price) || Infinity;
          const bv = parseFloat(b.dataset.price) || Infinity;
          return av - bv;
        }
        if (key === 'stock') {
          const order = { in_stock: 0, preorder: 1, unknown: 2, out_of_stock: 3 };
          return (order[a.dataset.stock] ?? 9) - (order[b.dataset.stock] ?? 9);
        }
        return a.cells[0].textContent.localeCompare(b.cells[0].textContent);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
</script>
</body>
</html>
`;

fs.writeFileSync('g7x-tracker.html', html);
fs.writeFileSync('index.html', html);

// ── HISTORY SNAPSHOTS ────────────────────────────────────────────
const tsFile = NOW_ISO.replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
fs.mkdirSync('history', { recursive: true });
fs.writeFileSync(`history/${tsFile}.json`, JSON.stringify(enriched, null, 2));
fs.writeFileSync(`history/${tsFile}.md`, md);

// ── STDOUT SUMMARY ───────────────────────────────────────────────
console.log(JSON.stringify({
  total, inStockHard, outStock, unknown,
  cheapest_overall: cheapestOverall ? { shop: cheapestOverall.shop, price: cheapestOverall.price_display } : null,
  cheapest_NL: cheapestByCountry.NL ? { shop: cheapestByCountry.NL.shop, price: cheapestByCountry.NL.price_display } : null,
  cheapest_BE: cheapestByCountry.BE ? { shop: cheapestByCountry.BE.shop, price: cheapestByCountry.BE.price_display } : null,
  cheapest_DE: cheapestByCountry.DE ? { shop: cheapestByCountry.DE.shop, price: cheapestByCountry.DE.price_display } : null,
}, null, 2));
