// Delta scrape: scrape only shops in registry that aren't already in scrape-results.json,
// or whose URL changed. Appends to scrape-results.json. Uses same logic as scrape.mjs.
import { chromium } from 'playwright';
import fs from 'fs';

const registry = JSON.parse(fs.readFileSync('shop-registry.json', 'utf8'));
const cache    = JSON.parse(fs.readFileSync('fetch-cache.json', 'utf8') || '{}');
let results;
try {
  results = JSON.parse(fs.readFileSync('scrape-results.json', 'utf8'));
} catch {
  results = [];
}

const seen = new Set(results.map(r => r.url));
const todo = registry.filter(s => !seen.has(s.url));

if (!todo.length) {
  console.log('No delta shops to scrape — registry is in sync with scrape-results.json.');
  process.exit(0);
}

console.log(`Delta scrape: ${todo.length} new shops (registry has ${registry.length}, results has ${results.length})`);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled']
});
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
             'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  extraHTTPHeaders: {
    'Accept-Language': 'fr-FR,fr;q=0.9,nl-NL;q=0.8,en;q=0.7'
  }
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = window.chrome || { runtime: {} };
});

let i = 0;
for (const t of todo) {
  i++;
  let hostname; try { hostname = new URL(t.url).hostname; } catch { hostname = 'invalid'; }
  const cacheEntry = cache[hostname] || { consecutive_fails: 0 };

  const page = await context.newPage();
  const result = { ...t, fetched_at: new Date().toISOString() };

  try {
    const response = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.http_status = response?.status() || 0;
    result.final_url = page.url();

    await page.waitForTimeout(2200);
    await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
    await page.waitForTimeout(700);

    // Inline-extract all the same logic as scrape.mjs (kept identical for consistency)
    const extracted = await page.evaluate((hints) => {
      const out = { price: null, currency: null, stock: 'unknown', source: null, title: null };
      out.title = document.querySelector('h1')?.textContent?.trim()?.slice(0, 200) || document.title?.slice(0, 200);

      if (hints?.price_selector) {
        const el = document.querySelector(hints.price_selector);
        if (el) { out.price = el.textContent.trim(); out.source = 'custom-selector'; }
      }
      if (!out.price) {
        const ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
        for (const n of ldNodes) {
          try {
            const data = JSON.parse(n.textContent);
            const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
            for (const item of items) {
              if (item['@type'] && !/Product|Offer/i.test(item['@type'])) continue;
              const offers = item.offers;
              const offer = Array.isArray(offers) ? offers[0] : offers;
              if (offer?.price) {
                out.price = offer.price; out.currency = offer.priceCurrency; out.source = 'json-ld';
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
      if (!out.price) {
        const m = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]');
        if (m?.content) { out.price = m.content; out.source = 'meta-tag'; }
      }
      if (!out.price) {
        // STRIKT: vereis € symbool OF expliciet decimaal-formaat (XXX,XX of X.XXX,XX)
        const all = [...document.querySelectorAll('span, div, p, strong, b')];
        const candidates = all.filter(el => el.children.length === 0)
          .map(el => (el.textContent || '').trim())
          .filter(t => t.length < 20)
          .filter(t => {
            const hasEuro = t.includes('€');
            const hasDecimal = /\d[,.]\d{2}\b/.test(t);
            if (!hasEuro && !hasDecimal) return false;
            const m = t.match(/(\d{1,2}[.\s]\d{3}|\d{3,4})([,.]\d{2})?/);
            if (!m) return false;
            const intPart = parseInt(m[1].replace(/[.\s]/g, ''));
            return intPart >= 200 && intPart <= 9999;
          })
          .slice(0, 5);
        if (candidates.length) { out.price = candidates[0]; out.source = 'heuristic'; }
      }

      if (out.stock === 'unknown') {
        const txt = document.body.innerText.toLowerCase().slice(0, 30000);
        const outStockHard = [
          /\bniet leverbaar\b/, /helaas is bezorging niet mogelijk/,
          /helaas is afhalen op de markt niet mogelijk/, /binnenkort weer beschikbaar/,
          /benachrichtige? mich(?: per e-?mail)?/, /benachrichtigen sie mich/,
          /e-mail mij wanneer (dit )?beschikbaar/, /stuur mij een bericht/,
          /melde mich, sobald/, /\buitverkocht\b/, /\bausverkauft\b/, /\bvergriffen\b/,
          /\bsold out\b/, /\bout of stock\b/, /\bépuisé\b/,
          /\bniet (meer )?op voorraad\b/, /tijdelijk niet beschikbaar/, /tijdelijk uitverkocht/,
          /nicht (mehr )?verfügbar/, /derzeit nicht verfügbar/, /momentan nicht verfügbar/,
          /nicht (mehr )?lieferbar/, /nicht auf lager/,
          /currently unavailable/, /not available/, /no longer available/,
          /n'est plus disponible/, /indisponible/, /article épuisé/, /produit indisponible/,
          /notify me when (this is )?(back )?in stock/, /benachrichtigung anfordern/,
          /uitverkocht\.\s|verkocht/, /me prévenir par e-?mail/, /me prévenir/,
          /rupture de stock/, /produit non disponible/
        ];
        const inStockHard = [
          /\bop voorraad\b(?!\s*bij)/, /\bdirect leverbaar\b/,
          /\bvandaag besteld[, ]+morgen in huis/, /verzonden binnen \d+ (werkdag|dag|uur)/,
          /\bauf lager\b/, /\bsofort lieferbar\b/, /\bsofort verfügbar\b/,
          /lieferung in \d+ (tag|werktag|stunde)/, /\d+\s+op voorraad/, /\d+\s+stuks op voorraad/,
          /direct beschikbaar voor verzending/, /\bin stock\b(?!\s*at)/,
          /vandaag verzonden/, /vandaag voor \d{1,2}:\d{2}/,
          /\ben stock\b/, /\bdisponible\b/, /expédié sous \d+/, /livraison sous \d+/
        ];
        const hasOos = outStockHard.some(r => r.test(txt));
        if (hasOos) {
          out.stock = 'out_of_stock';
        } else {
          const hasInStock = inStockHard.some(r => r.test(txt));
          const hasNotifySignal = /benachrichtige|notify me|stuur mij een bericht|e-mail mij|me prévenir/.test(txt);
          if (hasInStock && !hasNotifySignal) out.stock = 'in_stock';
        }
      }

      const fullText = document.body.innerText.slice(0, 30000);
      out.verified_mark_iii = /G7\s*X\s*(Mark\s*)?III\b|G7X\s*III\b|PowerShot G7 X III/i.test(fullText) &&
                              !/\bMark\s*II\b(?!I)|\bMark\s*IV\b/i.test(fullText.slice(0, 2000));
      const variantText = (out.title || '').toLowerCase();
      out.variant = /refurb|gereviseerd|generalüberholt|gebraucht|tweedehands|\bused\b|reconditionné/i.test(variantText) ? 'refurbished' :
                    /\bkit\b|met (lens|tas)|vlogger|vlogkit|streaming kit/i.test(variantText) ? 'kit' : 'body';
      const dm = fullText.match(
        /(morgen in huis|vandaag verzonden|verzonden binnen \d+ \w+|levertijd[:\s]+[^\n.]{1,40}|lieferung[:\s]+[^\n.]{1,40}|delivery[:\s]+[^\n.]{1,40}|sofort lieferbar|in \d+ werk(dag|tag)en?|livraison sous \d+ \w+|expédié sous \d+ \w+)/i
      );
      out.delivery = dm ? dm[0].trim().slice(0, 60) : null;
      return out;
    }, t.scrape_hints).catch(e => ({ extract_error: e.message?.slice(0, 100) }));

    Object.assign(result, extracted);
    cache[hostname] = {
      last_status: result.http_status, last_attempt: result.fetched_at,
      consecutive_fails: 0, preferred_method: extracted?.source || null
    };
  } catch (e) {
    result.error = e.message.slice(0, 200);
    result.http_status = result.http_status || 'error';
    cache[hostname] = {
      last_status: result.http_status, last_attempt: result.fetched_at,
      consecutive_fails: (cacheEntry.consecutive_fails || 0) + 1,
      last_error: e.message.slice(0, 100)
    };
  }
  results.push(result);
  console.log(`[${i}/${todo.length}] ${result.error ? 'ERR' : (result.price ? 'OK ' : '???')} ${t.shop}: ${result.price || result.error || 'no-price'} (${result.source || result.http_status || ''})`);
  await page.close();
  await new Promise(r => setTimeout(r, 1300 + Math.random() * 1500));
}

await browser.close();
fs.writeFileSync('scrape-results.json', JSON.stringify(results, null, 2));
fs.writeFileSync('fetch-cache.json', JSON.stringify(cache, null, 2));
console.log(`\nDelta done: +${todo.length} shops, total now ${results.length}.`);
