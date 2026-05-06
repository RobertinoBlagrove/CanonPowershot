import { chromium } from 'playwright';
import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('shop-registry.json', 'utf8'));
const cache = JSON.parse(fs.readFileSync('fetch-cache.json', 'utf8') || '{}');
const results = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled']
});

const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
             'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'nl-NL',
  timezoneId: 'Europe/Amsterdam',
  extraHTTPHeaders: {
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8,de;q=0.7'
  }
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // light noise on chrome.runtime
  window.chrome = window.chrome || { runtime: {} };
});

let i = 0;
for (const t of registry) {
  i++;
  let hostname;
  try { hostname = new URL(t.url).hostname; } catch { hostname = 'invalid'; }
  const cacheEntry = cache[hostname] || { consecutive_fails: 0 };

  // Skip-budget: 5+ fails -> 80% chance to skip
  if (cacheEntry.consecutive_fails >= 5 && Math.random() > 0.2) {
    results.push({ ...t, skipped: true, reason: `cooldown after ${cacheEntry.consecutive_fails} fails`,
                   fetched_at: new Date().toISOString() });
    process.stdout.write(`[${i}/${registry.length}] SKIP ${t.shop} (cooldown)\n`);
    continue;
  }

  const page = await context.newPage();
  const result = { ...t, fetched_at: new Date().toISOString() };

  try {
    const response = await page.goto(t.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    result.http_status = response?.status() || 0;
    result.final_url = page.url();

    if (t.scrape_hints?.wait_for_selector) {
      await page.waitForSelector(t.scrape_hints.wait_for_selector,
                                  { timeout: 8000 }).catch(() => {});
    }
    await page.waitForTimeout(t.scrape_hints?.extra_wait_ms || 2200);

    await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
    await page.waitForTimeout(700);

    const extracted = await page.evaluate((hints) => {
      const out = { price: null, currency: null, stock: 'unknown',
                    source: null, title: null };

      out.title = document.querySelector('h1')?.textContent?.trim()?.slice(0, 200) ||
                  document.title?.slice(0, 200);

      // 1. Custom selectors uit hints
      if (hints?.price_selector) {
        const el = document.querySelector(hints.price_selector);
        if (el) { out.price = el.textContent.trim(); out.source = 'custom-selector'; }
      }

      // 2. JSON-LD structured data
      if (!out.price) {
        const ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
        for (const n of ldNodes) {
          try {
            const data = JSON.parse(n.textContent);
            const items = Array.isArray(data) ? data :
                          data['@graph'] ? data['@graph'] : [data];
            for (const item of items) {
              if (item['@type'] && !/Product|Offer/i.test(item['@type'])) continue;
              const offers = item.offers;
              const offer = Array.isArray(offers) ? offers[0] : offers;
              if (offer?.price) {
                out.price = offer.price;
                out.currency = offer.priceCurrency;
                out.source = 'json-ld';
                if (offer.availability) {
                  if (/InStock/i.test(offer.availability)) out.stock = 'in_stock';
                  else if (/OutOfStock|SoldOut/i.test(offer.availability)) out.stock = 'out_of_stock';
                  else if (/PreOrder|BackOrder/i.test(offer.availability)) out.stock = 'preorder';
                }
                break;
              }
            }
            if (out.price) break;
          } catch {}
        }
      }

      // 3. Meta tags
      if (!out.price) {
        const metaPrice = document.querySelector(
          'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]'
        );
        if (metaPrice?.content) { out.price = metaPrice.content; out.source = 'meta-tag'; }
      }

      // 4. Heuristiek: leaf-elementen met €-prijs
      if (!out.price) {
        const all = [...document.querySelectorAll('span, div, p, strong, b')];
        const candidates = all
          .filter(el => el.children.length === 0)
          .map(el => (el.textContent || '').trim())
          .filter(t => /^€?\s?\d{2,4}([,.]\d{2})?\s?€?$/.test(t) && t.length < 20)
          .slice(0, 5);
        if (candidates.length) {
          out.price = candidates[0];
          out.source = 'heuristic';
        }
      }

      // VOORRAAD-detectie via tekst (als JSON-LD niets gaf)
      if (out.stock === 'unknown') {
        const txt = document.body.innerText.toLowerCase().slice(0, 20000);
        const inStock = [
          /op voorraad/, /direct leverbaar/, /vandaag besteld/,
          /morgen in huis/, /verzonden binnen \d/, /auf lager/,
          /sofort lieferbar/, /lieferung in \d/, /\bin stock\b/,
          /verzending vandaag/, /\d+ op voorraad/, /direct beschikbaar/,
          /direkt verfügbar/, /sofort verfügbar/
        ];
        const outStock = [
          /uitverkocht/, /niet (meer )?leverbaar/, /tijdelijk niet beschikbaar/,
          /nicht (mehr )?verfügbar/, /ausverkauft/, /\bout of stock\b/,
          /niet op voorraad/, /vergriffen/, /derzeit nicht verfügbar/,
          /tijdelijk uitverkocht/, /sold out/, /épuisé/, /nicht auf lager/
        ];
        if (inStock.some(r => r.test(txt))) out.stock = 'in_stock';
        else if (outStock.some(r => r.test(txt))) out.stock = 'out_of_stock';
      }

      // VERIFIEER Mark III
      const fullText = document.body.innerText.slice(0, 30000);
      out.verified_mark_iii =
        /G7\s*X\s*(Mark\s*)?III\b|G7X\s*III\b|PowerShot G7 X III/i.test(fullText) &&
        !/\bMark\s*II\b(?!I)|\bMark\s*IV\b/i.test(fullText.slice(0, 2000));

      // KIT/BODY/REFURB
      const variantText = ((out.title || '') + ' ' + fullText.slice(0, 800)).toLowerCase();
      out.variant = /refurb|gereviseerd|generalüberholt|gebraucht|tweedehands|used/i.test(variantText) ? 'refurbished' :
                    /\bkit\b|met (lens|tas)|vlogger|vlogkit|streaming kit/i.test(variantText) ? 'kit' :
                    'body';

      // Levertijd
      const deliveryMatch = fullText.match(
        /(morgen in huis|vandaag verzonden|verzonden binnen \d+ \w+|levertijd[:\s]+[^\n.]{1,40}|lieferung[:\s]+[^\n.]{1,40}|delivery[:\s]+[^\n.]{1,40}|sofort lieferbar|in \d+ werk(dag|tag)en?)/i
      );
      out.delivery = deliveryMatch ? deliveryMatch[0].trim().slice(0, 60) : null;

      return out;
    }, t.scrape_hints).catch(e => ({ extract_error: e.message?.slice(0, 100) }));

    Object.assign(result, extracted);
    cache[hostname] = {
      last_status: result.http_status,
      last_attempt: result.fetched_at,
      consecutive_fails: 0,
      preferred_method: extracted?.source || null
    };

  } catch (e) {
    result.error = e.message.slice(0, 200);
    result.http_status = result.http_status || 'error';
    cache[hostname] = {
      last_status: result.http_status,
      last_attempt: result.fetched_at,
      consecutive_fails: (cacheEntry.consecutive_fails || 0) + 1,
      last_error: e.message.slice(0, 100)
    };
  }

  results.push(result);
  const tag = result.error ? 'ERR' : (result.price ? 'OK ' : '???');
  process.stdout.write(`[${i}/${registry.length}] ${tag} ${t.shop}: ${result.price || result.error || 'no-price'} (${result.source || result.http_status || ''})\n`);
  await page.close();
  await new Promise(r => setTimeout(r, 1300 + Math.random() * 1500));
}

await browser.close();
fs.writeFileSync('scrape-results.json', JSON.stringify(results, null, 2));
fs.writeFileSync('fetch-cache.json', JSON.stringify(cache, null, 2));
const withPrice = results.filter(r => r.price).length;
const inStock = results.filter(r => r.stock === 'in_stock').length;
console.log(`\nDone: ${results.length} targets, ${withPrice} with price, ${inStock} in stock.`);
