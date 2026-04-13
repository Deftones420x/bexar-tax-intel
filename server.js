/**
 * Bexar County Tax Delinquency Intelligence — Backend Server
 * 
 * Reads your tax roll CSV, scrapes bexar.acttax.com for each account,
 * stores results in a local JSON database, and serves a REST API
 * for the dashboard. Refreshes every 3 hours automatically.
 * 
 * Setup:
 *   npm install express cors csv-parse node-fetch cheerio node-cron
 *   node server.js
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  CSV_PATH: './tax_roll.csv',          // Put your tax roll CSV here
  DB_PATH: './tax_results.json',       // Local results database
  PORT: 3001,
  BATCH_SIZE: 10,                      // Concurrent requests per batch
  DELAY_MS: 800,                       // Delay between batches (ms) — be polite to the server
  REFRESH_HOURS: 3,                    // Auto-refresh interval
  BASE_URL: 'https://bexar.acttax.com/act_webdev/bexar',
};

// ─── DATABASE ──────────────────────────────────────────────────────────────
function loadDB() {
  if (fs.existsSync(CONFIG.DB_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG.DB_PATH, 'utf8'));
  }
  return {
    lastFullScan: null,
    lastRefresh: null,
    scanInProgress: false,
    totalAccounts: 0,
    scannedAccounts: 0,
    results: {}
  };
}

function saveDB(db) {
  fs.writeFileSync(CONFIG.DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ─── CSV PARSER (streaming — file is ~1 GB) ──────────────────────────────
function loadTaxRoll() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CONFIG.CSV_PATH)) {
      console.warn(`⚠️  Tax roll CSV not found at ${CONFIG.CSV_PATH}`);
      return resolve([]);
    }

    const latest = new Map();   // account → row  (most recent year wins)
    let totalRows = 0;

    const parser = fs.createReadStream(CONFIG.CSV_PATH)
      .pipe(parse({ columns: true, skip_empty_lines: true }));

    parser.on('data', (row) => {
      const account = (row['ACCOUNT'] || '').trim();
      if (!account) return;

      const year = parseInt(row['YEAR'], 10) || 0;
      const existing = latest.get(account);
      if (existing && existing.year >= year) return;   // skip older year

      totalRows++;
      latest.set(account, {
        account,
        year,
        levy:             parseFloat((row['LEVY'] || '0').replace(/[,$]/g, '')) || 0,
        homestead:        (row['HOMESTEAD'] || '').trim(),
        over65:           (row['OVER65'] || '').trim(),
        veteran:          (row['VETERAN'] || '').trim(),
        disabled:         (row['DISABLED'] || '').trim(),
        datePaid:         (row['DATE-PAID'] || '').trim(),
        dueDate:          (row['DUE-DATE'] || '').trim(),
        levyBalance:      parseFloat((row['LEVY-BALANCE'] || '0').replace(/[,$]/g, '')) || 0,
        suit:             (row['SUIT'] || '').trim(),
        deferral:         (row['DEFERRAL'] || '').trim(),
        ownerName:        (row['OWNER'] || '').trim(),
        mailingAddress:   (row['ADDRESS2'] || '').trim(),
        mailingCity:      (row['CITY'] || '').trim(),
        mailingState:     (row['STATE'] || '').trim(),
        mailingZip:       (row['ZIP'] || '').trim(),
        parcelName:       (row['PARCEL-NAME'] || '').trim(),
        propertyAddress:  (row['PARCEL-NAME'] || '').trim(),
        rollAmountDue:    parseFloat((row['TOT-AMT-DUE'] || '0').replace(/[,$]/g, '')) || 0,
        paymentAgreement: (row['PAYMENT-AGREEMENT'] || '').trim(),
      });

      if (totalRows % 1000000 === 0) {
        console.log(`  📖 Streamed ${totalRows.toLocaleString()} rows so far...`);
      }
    });

    parser.on('end', () => {
      console.log(`📂 Streamed CSV → ${latest.size.toLocaleString()} unique accounts (most recent year each)`);
      resolve(Array.from(latest.values()));
    });

    parser.on('error', reject);
  });
}

// ─── SCRAPER ───────────────────────────────────────────────────────────────

/** Parse Set-Cookie headers and return a cookie string for subsequent requests */
function parseCookies(response) {
  const raw = response.headers.raw()['set-cookie'] || [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function scrapeAccount(account) {
  try {
    // ── Step 1: GET index.jsp to establish a session cookie ──
    const indexUrl = `${CONFIG.BASE_URL}/index.jsp`;

    const indexRes = await fetch(indexUrl, {
      headers: COMMON_HEADERS,
      redirect: 'manual',
      timeout: 15000,
    });

    if (!indexRes.ok && indexRes.status !== 302) {
      return { account, error: `Index page HTTP ${indexRes.status}`, scrapedAt: new Date().toISOString() };
    }

    const cookies = parseCookies(indexRes);
    console.log(`[SCRAPE ${account}] Step 1 — GET index.jsp → HTTP ${indexRes.status}, cookies: ${cookies ? cookies.substring(0, 80) + '...' : '(none)'}`);

    // ── Step 2: POST the search form (searchby=4 → Account Number) ──
    const searchBody = new URLSearchParams({
      searchby: '4',
      criteria: account,
      subcriteria: '',
    });

    const postRes = await fetch(indexUrl, {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Referer': indexUrl,
        'Origin': 'https://bexar.acttax.com',
      },
      body: searchBody.toString(),
      redirect: 'manual',          // handle redirects ourselves so we keep cookies
      timeout: 15000,
    });

    // Merge any new cookies from the POST response
    const postCookies = parseCookies(postRes);
    const allCookies = [cookies, postCookies].filter(Boolean).join('; ');
    console.log(`[SCRAPE ${account}] Step 2 — POST index.jsp → HTTP ${postRes.status}, location: ${postRes.headers.get('location') || '(none)'}`);

    // ── Step 3: Follow redirect(s) to the detail / results page ──
    let html;
    if (postRes.status >= 300 && postRes.status < 400) {
      const location = postRes.headers.get('location');
      const redirectUrl = location.startsWith('http')
        ? location
        : new URL(location, indexUrl).href;
      console.log(`[SCRAPE ${account}] Step 3 — Following redirect to: ${redirectUrl}`);

      const detailRes = await fetch(redirectUrl, {
        headers: { ...COMMON_HEADERS, 'Cookie': allCookies, 'Referer': indexUrl },
        redirect: 'follow',
        timeout: 15000,
      });

      if (!detailRes.ok) {
        console.log(`[SCRAPE ${account}] Step 3 FAILED — HTTP ${detailRes.status}`);
        return { account, error: `Detail page HTTP ${detailRes.status}`, scrapedAt: new Date().toISOString() };
      }
      html = await detailRes.text();
    } else if (postRes.ok) {
      // No redirect — results came back inline
      html = await postRes.text();
      console.log(`[SCRAPE ${account}] Step 2 returned inline HTML (no redirect)`);
    } else {
      console.log(`[SCRAPE ${account}] Step 2 FAILED — HTTP ${postRes.status}`);
      return { account, error: `Search POST HTTP ${postRes.status}`, scrapedAt: new Date().toISOString() };
    }

    // Log what we actually got back
    const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    console.log(`[SCRAPE ${account}] Page title: "${pageTitle ? pageTitle[1].trim() : '(none)'}"`);
    console.log(`[SCRAPE ${account}] HTML length: ${html.length} chars`);
    // Dump first 2000 chars of body text for debugging
    const debugText = cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim().substring(0, 2000);
    console.log(`[SCRAPE ${account}] Body text preview:\n${debugText}\n`);

    // ── Step 3b: If we landed on a results list, follow the first detail link ──
    let $ = cheerio.load(html);
    const detailLink = $('a[href*="detail.jsp"], a[href*="showdetail"], a[href*="Detail"]')
      .first().attr('href');
    console.log(`[SCRAPE ${account}] Detail link found: ${detailLink || '(none)'}`);
    console.log(`[SCRAPE ${account}] Has "Total Amount Due" in HTML: ${html.includes('Total Amount Due')}`);

    if (detailLink && !html.includes('Total Amount Due')) {
      const detailUrl = detailLink.startsWith('http')
        ? detailLink
        : new URL(detailLink, indexUrl).href;
      console.log(`[SCRAPE ${account}] Step 3b — Following detail link: ${detailUrl}`);

      const detailRes = await fetch(detailUrl, {
        headers: { ...COMMON_HEADERS, 'Cookie': allCookies, 'Referer': indexUrl },
        redirect: 'follow',
        timeout: 15000,
      });

      if (detailRes.ok) {
        html = await detailRes.text();
        $ = cheerio.load(html);
        const detailText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2000);
        console.log(`[SCRAPE ${account}] Detail page text preview:\n${detailText}\n`);
      } else {
        console.log(`[SCRAPE ${account}] Step 3b FAILED — HTTP ${detailRes.status}`);
      }
    }

    // ── Step 4: Parse the detail page ──
    const bodyText = $('body').text();
    const result = { account, scrapedAt: new Date().toISOString(), error: null };

    // Account confirmed on page
    result.accountOnSite = bodyText.includes(account);

    // Owner/address block
    result.ownerOnSite = extractField($, 'Address', 0);
    result.siteAddress = extractBold($, 'Property Site Address');

    // Tax amounts
    result.taxLevy2025 = extractMoney(bodyText, '2025 Year Tax Levy');
    result.amountDue2025 = extractMoney(bodyText, '2025 Year Amount Due');
    result.priorYearsDue = extractMoney(bodyText, 'Prior Year\\(s\\) Amount Due');
    result.totalAmountDue = extractMoney(bodyText, 'Total Amount Due');
    result.delinquentAfter = extractDate(bodyText, 'Delinquent After');

    // Payment history
    result.lastPaymentAmount = extractMoney(bodyText, 'Last Payment Amount Received');
    result.lastPaymentDate = extractDate(bodyText, 'Last Payment Date');
    result.lastPayer = extractText(bodyText, 'Last Payer');

    // Market values
    result.totalMarketValue = extractMoney(bodyText, 'Total Market Value');
    result.landValue = extractMoney(bodyText, 'Land Value');
    result.improvementValue = extractMoney(bodyText, 'Improvement Value');

    // Exemptions
    result.exemptions = extractText(bodyText, 'Exemptions \\(current year only\\)');

    // KEY FLAGS
    result.hasActiveDeferral = bodyText.toLowerCase().includes('active deferral');
    result.hasTaxLoan = bodyText.toLowerCase().includes('tax lien') || bodyText.toLowerCase().includes('tax loan') || result.hasActiveDeferral;
    result.isDelinquent = (result.totalAmountDue || 0) > 0 && (result.priorYearsDue || 0) > 0;
    result.neverPaid = bodyText.includes('Not Received') || result.lastPaymentDate === null;

    // Direct link for the user
    result.paymentHistoryUrl = `${CONFIG.BASE_URL}/index.jsp`;
    result.directUrl = `${CONFIG.BASE_URL}/index.jsp`;

    console.log(`[SCRAPE ${account}] PARSED → accountOnSite=${result.accountOnSite}, totalDue=$${result.totalAmountDue}, levy=$${result.taxLevy2025}, priorDue=$${result.priorYearsDue}, marketVal=$${result.totalMarketValue}, delinquent=${result.isDelinquent}`);

    return result;

  } catch (err) {
    return { account, error: err.message, scrapedAt: new Date().toISOString() };
  }
}

// ─── PARSE HELPERS ─────────────────────────────────────────────────────────
function extractMoney(text, label) {
  const regex = new RegExp(label + '[^\\$]*\\$([\\d,\\.]+)', 'i');
  const match = text.match(regex);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

function extractDate(text, label) {
  const regex = new RegExp(label + '[:\\s]*([\\d]{1,2}/[\\d]{1,2}/[\\d]{4})', 'i');
  const match = text.match(regex);
  return match ? match[1] : null;
}

function extractText(text, label) {
  const regex = new RegExp(label + '[:\\s]*([A-Z0-9 ,&]+?)(?:\\n|\\r|\\s{2,})', 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function extractBold($, label) {
  let result = null;
  $('b, strong').each((i, el) => {
    if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
      result = $(el).parent().text().replace($(el).text(), '').trim();
    }
  });
  return result;
}

function extractField($, label, index) {
  return null; // Placeholder — cheerio-based extraction used where needed
}

// ─── BATCH SCRAPER ─────────────────────────────────────────────────────────
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runFullScan() {
  if (db.scanInProgress) {
    console.log('⏳ Scan already in progress, skipping...');
    return;
  }

  const records = await loadTaxRoll();
  if (!records.length) {
    console.log('❌ No records found in tax roll CSV');
    return;
  }

  console.log(`🚀 Starting full scan of ${records.length} accounts...`);
  db.scanInProgress = true;
  db.totalAccounts = records.length;
  db.scannedAccounts = 0;
  db.lastRefresh = new Date().toISOString();
  saveDB(db);

  // Process in batches
  for (let i = 0; i < records.length; i += CONFIG.BATCH_SIZE) {
    const batch = records.slice(i, i + CONFIG.BATCH_SIZE);
    
    const batchResults = await Promise.all(
      batch.map(record => scrapeAccount(record.account))
    );

    // Merge scrape results with tax roll data
    batch.forEach((record, idx) => {
      const scraped = batchResults[idx];
      db.results[record.account] = {
        ...record,           // Your tax roll data
        ...scraped,          // Live site data
        rollAmountDue: record.rollAmountDue,  // Keep original for comparison
      };
    });

    db.scannedAccounts = Math.min(i + CONFIG.BATCH_SIZE, records.length);
    
    // Save every 100 accounts
    if (i % 100 === 0) {
      saveDB(db);
      const pct = Math.round((db.scannedAccounts / db.totalAccounts) * 100);
      console.log(`  📊 Progress: ${db.scannedAccounts}/${db.totalAccounts} (${pct}%)`);
    }

    await delay(CONFIG.DELAY_MS);
  }

  db.scanInProgress = false;
  db.lastFullScan = new Date().toISOString();
  saveDB(db);
  console.log(`✅ Scan complete! ${records.length} accounts processed.`);
}

// ─── API ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  db = loadDB();
  const results = Object.values(db.results);
  const delinquent = results.filter(r => r.isDelinquent);
  const withDeferral = results.filter(r => r.hasActiveDeferral);
  const neverPaid = results.filter(r => r.neverPaid && r.isDelinquent);
  
  res.json({
    lastFullScan: db.lastFullScan,
    lastRefresh: db.lastRefresh,
    scanInProgress: db.scanInProgress,
    progress: db.totalAccounts ? Math.round((db.scannedAccounts / db.totalAccounts) * 100) : 0,
    scannedAccounts: db.scannedAccounts,
    totalAccounts: db.totalAccounts,
    stats: {
      total: results.length,
      delinquent: delinquent.length,
      withDeferral: withDeferral.length,
      neverPaid: neverPaid.length,
      totalDelinquentValue: delinquent.reduce((sum, r) => sum + (r.totalAmountDue || 0), 0),
    }
  });
});

app.get('/api/properties', (req, res) => {
  db = loadDB();
  const results = Object.values(db.results);
  
  // Filters
  const { 
    delinquent, deferral, neverPaid, search, 
    minOwed, maxOwed, propertyClass,
    page = 1, limit = 50, sort = 'totalAmountDue', order = 'desc'
  } = req.query;

  let filtered = results;

  if (delinquent === 'true') filtered = filtered.filter(r => r.isDelinquent);
  if (deferral === 'true') filtered = filtered.filter(r => r.hasActiveDeferral);
  if (neverPaid === 'true') filtered = filtered.filter(r => r.neverPaid);
  if (propertyClass) filtered = filtered.filter(r => r.parcelName?.toLowerCase().includes(propertyClass.toLowerCase()));
  if (minOwed) filtered = filtered.filter(r => (r.totalAmountDue || 0) >= parseFloat(minOwed));
  if (maxOwed) filtered = filtered.filter(r => (r.totalAmountDue || 0) <= parseFloat(maxOwed));
  
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(r =>
      r.account?.toLowerCase().includes(s) ||
      r.ownerName?.toLowerCase().includes(s) ||
      r.parcelName?.toLowerCase().includes(s) ||
      r.mailingAddress?.toLowerCase().includes(s)
    );
  }

  // Sort
  filtered.sort((a, b) => {
    const aVal = a[sort] || 0;
    const bVal = b[sort] || 0;
    return order === 'desc' ? bVal - aVal : aVal - bVal;
  });

  // Paginate
  const total = filtered.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const paginated = filtered.slice(offset, offset + parseInt(limit));

  res.json({
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    pages: Math.ceil(total / parseInt(limit)),
    data: paginated
  });
});

app.get('/api/property/:account', (req, res) => {
  db = loadDB();
  const prop = db.results[req.params.account];
  if (!prop) return res.status(404).json({ error: 'Account not found' });
  res.json(prop);
});

// Trigger manual rescan of specific account
app.post('/api/rescan/:account', async (req, res) => {
  db = loadDB();
  const { account } = req.params;
  const taxRoll = await loadTaxRoll();
  const rollRecord = taxRoll.find(r => r.account === account);
  
  const scraped = await scrapeAccount(account);
  db.results[account] = { ...(rollRecord || {}), ...scraped };
  saveDB(db);
  
  res.json(db.results[account]);
});

// Trigger full rescan
app.post('/api/scan', (req, res) => {
  if (db.scanInProgress) {
    return res.json({ message: 'Scan already in progress', progress: db.scannedAccounts });
  }
  runFullScan(); // Don't await — runs in background
  res.json({ message: 'Scan started', totalAccounts: db.totalAccounts });
});

app.get('/api/export', (req, res) => {
  db = loadDB();
  const results = Object.values(db.results).filter(r => r.isDelinquent);
  
  // Build CSV
  const headers = ['Account', 'Year', 'Owner', 'Parcel Name', 'Address2', 'City', 'State', 'Zip',
    'Levy', 'Levy Balance', 'Roll Amount Due', 'Live Total Due', 'Prior Years Due',
    'Date Paid', 'Due Date', 'Homestead', 'Over65', 'Veteran', 'Disabled',
    'Suit', 'Deferral', 'Payment Agreement', 'Has Active Deferral', 'Never Paid',
    'Total Market Value', 'Direct URL'];

  const rows = results.map(r => [
    r.account, r.year, r.ownerName, r.parcelName, r.mailingAddress, r.mailingCity,
    r.mailingState, r.mailingZip, r.levy, r.levyBalance, r.rollAmountDue,
    r.totalAmountDue, r.priorYearsDue, r.datePaid, r.dueDate,
    r.homestead, r.over65, r.veteran, r.disabled, r.suit, r.deferral,
    r.paymentAgreement, r.hasActiveDeferral, r.neverPaid,
    r.totalMarketValue, r.directUrl
  ]);

  const csv = [headers, ...rows].map(row => row.map(v => `"${v ?? ''}"`).join(',')).join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=bexar_delinquent_export.csv');
  res.send(csv);
});

// ─── SCHEDULER ─────────────────────────────────────────────────────────────
// Run every 3 hours
cron.schedule(`0 */3 * * *`, () => {
  console.log('⏰ Scheduled 3-hour refresh starting...');
  runFullScan();
});

// ─── START ──────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🏠 Bexar Tax Intel Server running on http://localhost:${CONFIG.PORT}`);
  console.log(`📋 Place your tax roll CSV at: ${path.resolve(CONFIG.CSV_PATH)}`);
  console.log(`💾 Results database: ${path.resolve(CONFIG.DB_PATH)}`);
  console.log(`⏰ Auto-refresh: every ${CONFIG.REFRESH_HOURS} hours\n`);
  
  // Load existing DB
  db = loadDB();
  
  // Auto-start scan if no data yet
  if (!db.lastFullScan && !db.scanInProgress) {
    console.log('🔍 No previous scan found — starting initial scan in 5 seconds...');
    setTimeout(runFullScan, 5000);
  } else {
    console.log(`✅ Loaded ${Object.keys(db.results).length} existing results`);
    console.log(`📅 Last scan: ${db.lastFullScan || 'Never'}`);
  }
});
