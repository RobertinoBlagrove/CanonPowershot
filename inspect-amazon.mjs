// Inspecteert de Amazon NL Black product-pagina en dumpt elk element dat eruit
// ziet als een prijs, met bijbehorende selector-paden. Doel: de juiste
// scrape_hints.price_selector vinden voor Amazon-shops.
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://www.amazon.nl/Canon-PowerShot-Mark-Schwarz-Digitalkamera/dp/B07V3NBJC3';

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
  extraHTTPHeaders: { 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' }
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await ctx.newPage();
console.log(`→ ${url}`);
const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log(`HTTP: ${resp?.status()}`);
console.log(`Final URL: ${page.url()}`);
await page.waitForTimeout(4000);

// Title
console.log(`Title: ${await page.title()}`);

// Try common Amazon price selectors and report what each returned
const candidates = [
  '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .a-price-whole',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#priceblock_saleprice',
  '.priceToPay .a-offscreen',
  '#apex_desktop .a-price .a-offscreen',
  '#corePrice_feature_div .a-offscreen',
  '#corePrice_desktop .a-price .a-offscreen',
  '.a-price.priceToPay .a-offscreen',
  '.a-price.aok-align-center .a-offscreen',
  '#newOfferAccordionRow .a-price .a-offscreen',
  '#availability span',
  '#availability .a-color-success',
  '#availability .a-color-state',
  '.a-color-price',
  '#productTitle'
];

console.log('\n=== Selector test ===');
for (const sel of candidates) {
  const matched = await page.$$eval(sel, els => els.slice(0, 3).map(e => (e.textContent || '').trim().slice(0, 80)))
    .catch(e => ['(error: ' + e.message.slice(0, 50) + ')']);
  if (matched.length) {
    console.log(`  ${sel}: ${JSON.stringify(matched)}`);
  } else {
    console.log(`  ${sel}: <no match>`);
  }
}

// Also: scan all elements with "€" near the top and report their selectors
console.log('\n=== All € occurrences in first 200 leaf elements ===');
const euros = await page.evaluate(() => {
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (!t.includes('€') && !/\d[,.]\d{2}/.test(t)) continue;
    if (t.length > 30) continue;
    // build a CSS-ish path
    const path = [];
    let n = el;
    while (n && n.nodeType === 1 && path.length < 5) {
      let seg = n.tagName.toLowerCase();
      if (n.id) seg += '#' + n.id;
      else if (n.className && typeof n.className === 'string') {
        const cls = n.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) seg += '.' + cls;
      }
      path.unshift(seg);
      n = n.parentElement;
    }
    out.push({ text: t, path: path.join(' > ') });
    i++;
    if (i > 25) break;
  }
  return out;
});
for (const e of euros) {
  console.log(`  "${e.text}"  ←  ${e.path}`);
}

await browser.close();
