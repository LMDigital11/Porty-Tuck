# Porty Tuck Shop

Simple tuck-shop system that runs on Cloudflare Workers with a D1 database. You get a public ordering page and an admin dashboard in one file (`index.html`).

---

## What you get

- **Public order page** (`/?order=1`) — choose items, see total, print receipt.
- **Admin / owner** — add/remove stock, sell items, manage deals, view events, reconcile cash, use SumUp card payments, create backups.
- **Deals** — pick items, set a deal price and end date; prices adjust so the deal total equals what you entered exactly. Profit is shown as `deal price - item cost (buyPrice)`.
- **Login / security** — owner login is rate-limited; admin-only access during lockout; full store loads for unauthenticated users (no data loss on refresh/reopen), with secrets redacted.
- **Performance** — lazy QR scanner, version-based refresh, service worker (`sw.js`), security headers.

---

## Requirements

- A [Cloudflare account](https://dash.cloudflare.com/) with Workers + D1 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A D1 database named `data` bound to the worker (see `wrangler.toml`)

---

## First-time setup

1. **Clone / download** this repo.
2. **Create / bind D1** (database name must be `data`):
   ```bash
   npx wrangler d1 create data
   ```
   Then update `wrangler.toml` if the binding ID changes.
3. **Install dependencies** (if any; mainly just deploy):
   ```bash
   npm install   # optional — no build step needed, but keep if you add packages
   ```
4. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
5. **Open the site** at the Workers URL (shown after deploy) or your custom domain.

---

## First startup (database)

The app creates its tables automatically (`app_state`, `sessions`, `rate_limit`). On first visit it also creates a default admin user (`admin`) and owner (`backdoor`) if no users exist — but it will **never overwrite existing users**, so your data stays safe.

After first deploy, check the DB is healthy:
- Open the site.
- Try logging in with the initial admin account (you will be asked to change the temporary password on first login).

---

## How to use it

### Public customers (`/?order=1`)
1. Visit the site and click **Order** (or go to `/?order=1`).
2. Pick items and quantities, then confirm.
3. Print or save the receipt.

### Admin / owner
1. Log in from the sidebar/login screen.
2. **Stock** — add/edit items with `buyPrice` (cost) and `sellPrice`. The deal-profit calculation uses `buyPrice`.
3. **Sell** — quick-sale items (deducts stock).
4. **Deals** (Money tab) — create a deal:
   - Name it.
   - Check the items included and set quantities.
   - Enter the deal total price and optional end date.
   - Save. The deal will scale item prices so the selected items add up exactly to your deal total. The preview shows `Profit` (positive) or `Loss` (negative) based on `deal price - item costs`.
5. **Events** — record events and expenses.
6. **Orders / Recurring** — track orders.
7. **Admin settings** — maintenance mode, lockout, user management, backups, cash reconciliation, SumUp card settings.

---

## Setup notes / things to check on first use

- The `DB` binding in `wrangler.toml` must point to a D1 database called `data`.
- The site serves `index.html` at `/` and `/index.html`.
- API endpoints (load, version, deals) work without auth, but secrets (`apiConfig`) are hidden for unauth users.
- If you restore `tuck:users` from a time-travel backup, make sure `tuck:lockout` is disabled in the DB if you want normal login to work.
- The deal pricing logic relies on `item.buyPrice`. If `buyPrice` is missing or `0`, deal profit will show incorrectly — set real costs on items.

---

## Security / data notes

- Passwords use salted SHA-256 (existing hashes preserved; do not change the hashing method or wipe D1).
- Rate limits apply to login and verification.
- A hardcoded backdoor account exists for recovery (`backdoor`) — it is never recreated if already present, so it stays safe.
- CSP is set to `unsafe-inline` because the app uses inline scripts/styles.

---

## Quick deploy (after changes)

```bash
npx wrangler deploy
```

The site will reflect your latest `index.html` and `src/index.ts` immediately.
