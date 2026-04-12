# Bexar Tax Intel — Delinquency Intelligence System

Real-time tax delinquency tracking for 28,594 Bexar County properties.
Cross-references your tax roll against bexar.acttax.com for live balances,
payment history, and active tax loan/deferral detection.

---

## What This Does

- Reads your tax roll CSV (28,594 accounts)
- Hits bexar.acttax.com for EACH account automatically
- Pulls: live total owed, prior years due, last payment date, active deferral flag
- Compares live amounts vs. your roll data — flags discrepancies
- Identifies: truly delinquent, never paid, has active tax loan/deferral
- Refreshes every 3 hours automatically
- Exports filtered results to CSV for GHL import

---

## Setup (One Time)

### 1. Install Node.js
Download from https://nodejs.org — get the LTS version.

### 2. Set up the server folder
```
bexar-tax-intel/
  server.js
  package.json
  dashboard.html
  tax_roll.csv       ← PUT YOUR CSV HERE (rename it to tax_roll.csv)
```

### 3. Install dependencies
Open Terminal, navigate to the folder:
```bash
cd bexar-tax-intel
npm install
```

### 4. Run the server
```bash
node server.js
```

You'll see:
```
🏠 Bexar Tax Intel Server running on http://localhost:3001
📋 Place your tax roll CSV at: /path/to/tax_roll.csv
⏰ Auto-refresh: every 3 hours

🔍 No previous scan found — starting initial scan in 5 seconds...
```

### 5. Open the dashboard
Double-click `dashboard.html` — or open it in Chrome.

---

## Your Tax Roll CSV

The CSV must have these column headers (already matched to your file):
- `Account`
- `Owner Name`
- `Property Address`
- `Property City`, `Property State`, `Property Zip`
- `Total Amount Due`
- `Property Class`

Rename your file to `tax_roll.csv` and place it in the server folder.

---

## First Scan Time Estimate

28,594 accounts × ~800ms delay = approximately 6-7 hours for a full scan.

The system runs in batches of 10 accounts at a time with a delay between
batches to avoid getting rate-limited by the county website.

Results are saved progressively — you can use the dashboard while it scans.

---

## Features

### Dashboard
- Live stats: delinquent count, total $ owed, tax loan/deferral count, never-paid count
- Sortable table: click column headers
- Filters: delinquent only, tax loan/deferral, never paid, amount range, property class
- Search: owner name, account number, address
- Property detail modal: full breakdown, direct link to assessor site

### Flags Per Property
- ⚠ Delinquent: has prior year(s) due
- ⚡ Tax Loan: account has an active deferral (they borrowed to pay taxes)
- ✗ No Payments: no payment has ever been received
- Variance: live amount vs. your roll amount

### Auto-Refresh
- Every 3 hours the system re-scans all accounts
- Countdown timer shown in dashboard header

### Export
Click "Export" in the dashboard to download a CSV of all delinquent properties
with live data — ready to import into GHL.

---

## Running on a Server (Optional)

To run 24/7 without your computer staying on:
```bash
npm install -g pm2
pm2 start server.js --name bexar-tax-intel
pm2 startup   # Makes it restart automatically on reboot
```

Then access the API from anywhere at your server's IP:3001.

---

## Key API Endpoints

```
GET  /api/status              — Scan progress and summary stats
GET  /api/properties          — Filtered/paginated property list
GET  /api/property/:account   — Single property detail
POST /api/rescan/:account     — Re-scrape one account immediately
POST /api/scan                — Trigger full rescan now
GET  /api/export              — Download delinquent list as CSV
```
