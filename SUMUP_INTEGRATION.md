# SumUp Integration — Re-addition Guide

This document explains how the SumUp integration was removed from Porty Tuck Shop and how to add it back if needed.

## What was removed

The full SumUp Cloud API integration was removed for simplicity. This included:

### Backend (`src/index.ts`)
- All `/api/sumup/*` route handlers:
  - `POST /api/sumup/transactions/test` — test API key + merchant code
  - `GET /api/sumup/transactions` — transaction history proxy
  - `GET /api/sumup/balance` — balance calculator (gross sales, refunds, payouts, etc.)
  - `POST /api/sumup/readers/list` — list paired readers
  - `POST /api/sumup/readers/create` — pair a reader
  - `POST /api/sumup/readers/status` — reader online status
  - `POST /api/sumup/readers/delete` — unpair a reader
  - `POST /api/sumup/readers/checkout` — send payment to Solo reader (idempotent via `client_ref`)
  - `GET /api/sumup/readers/checkout/status` — poll checkout status
  - `POST /api/sumup/readers/terminate` — cancel a checkout
  - `POST /api/sumup/webhook` — receive `solo.transaction.updated` events
  - `GET /api/sumup/webhook/events` — list webhook events
- Helper functions: `sumupCloudApi`, `readSumupBody`, `sumupVerifyWebhookSignature`, `loadSumupWebhookEvents`, `appendSumupWebhookEvent`, `upsertSumupCheckout`, `getSumupCheckout`, `updateSumupCheckoutStatus`, `markSumupCheckoutProcessed`
- `sumup_checkouts` D1 table creation (table may still exist in DB, just unused)
- SumUp fields from `apiConfig` type (`sumupApiUrl`, `sumupApiKey`, `sumupMerchantCode`, `affiliateKey`, `appId`, `sumupPaymentMethod`, `sumupReaderId`, `sumupReaderName`, `sumupWebhookSecret`)

### Frontend (`index.html`)
- SumUp API configuration section (API key, merchant code, affiliate key, app ID inputs)
- Test connection button
- Solo reader pairing section (refresh, unpair, reader status)
- SumUp balance calculator section
- Webhook secret input
- All associated JavaScript functions

### What was KEPT
- **"Pay with SumUp" button** at checkout — opens SumUp app on phone via `sumupmerchant://` URL scheme
- **Pending payments** list with manual confirm/cancel
- **Manual SumUp amount tracking** (enter actual, remove adjustment)
- `money.sumup` (actual, expectedAdjustment, lastUpdatedAt) — all data preserved
- `foreignTxId` on sales for transaction matching

## How to re-add the SumUp integration

### Step 1: Install SumUp skills (already installed)
```bash
npx skills add sumup/sumup-skills@sumup -y
npx skills add sumup/sumup-skills@sumup-best-practices -y
npx skills add sumup/sumup-skills@sumup-testing -y
npx skills add sumup/sumup-skills@sumup-debug -y
```

Skills are in `.agents/skills/` directory.

### Step 2: Restore `apiConfig` type in `src/index.ts`
Add back to the `StoreDocument` type:
```typescript
apiConfig: {
  sumupApiUrl: string;
  sumupApiKey: string;
  sumupMerchantCode: string;
  affiliateKey: string;
  appId: string;
  cashRemovalCode: string;
  sumupPaymentMethod: string;
  sumupReaderId: string;
  sumupReaderName: string;
  sumupWebhookSecret: string;
};
```

And in `blankStore()`:
```typescript
apiConfig: {
  sumupApiUrl: "",
  sumupApiKey: "",
  sumupMerchantCode: "",
  affiliateKey: "",
  appId: "",
  cashRemovalCode: "",
  sumupPaymentMethod: "app",
  sumupReaderId: "",
  sumupReaderName: "",
  sumupWebhookSecret: "",
},
```

### Step 3: Add back API routes
Reference the git history (commit `9f1d500` and earlier) for the full route implementations. Key endpoints:
- `POST /api/sumup/transactions/test` — validates API key
- `GET /api/sumup/transactions` — proxies transaction history
- `GET /api/sumup/balance` — calculates pending balance
- `POST /api/sumup/readers/*` — reader management
- `POST /api/sumup/readers/checkout` — send payment to Solo (idempotent)
- `GET /api/sumup/readers/checkout/status` — poll checkout status
- `POST /api/sumup/webhook` — receive payment notifications

### Step 4: Add back `sumup_checkouts` table
```sql
CREATE TABLE IF NOT EXISTS sumup_checkouts (
  id TEXT PRIMARY KEY,
  merchant_code TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  client_ref TEXT UNIQUE,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);
```

### Step 5: Restore frontend UI
Reference git history for:
- SumUp API configuration dialog and section
- Solo reader pairing UI
- SumUp balance calculator
- Webhook secret input
- Associated JavaScript functions

### Step 6: Configure credentials
1. Get API key (`sup_sk_...`) and merchant code from SumUp Dashboard
2. Enter in app: Money → SumUp API → Configure
3. For Solo reader: pair via SumUp Dashboard (Developers → Readers → Add reader)
4. Set payment method to "Solo reader (Cloud API)"

## Key SumUp resources

### Official documentation
- Cloud API: https://developer.sumup.com/terminal-payments/cloud-api/
- Pairing Solo: https://developer.sumup.com/terminal-payments/guides/pairing-solo/
- In-person testing: https://developer.sumup.com/terminal-payments/testing/
- Virtual Solo: https://virtual-solo.sumup.com/

### Installed skills
- `sumup` — main integration skill (Membrane CLI)
- `sumup-best-practices` — credential model, security
- `sumup-testing` — sandbox setup, test cards, decline amounts
- `sumup-debug` — diagnose payment failures
- `sumup-mcp` — MCP server configuration
- `upgrade-sumup` — SDK version bumps

### Key concepts
- **Secret API key** (`sup_sk_...`) — server-side, full access
- **Public key** (`sup_pk_...`) — client-side only
- **Affiliate key** — required for Cloud API checkout requests
- **client_ref / foreign_transaction_id** — idempotency key for payments
- **solo.transaction.updated** — webhook event for payment completion
- **Virtual Solo** — browser-based reader simulator for testing

### Important notes
- Cloud API webhooks are NOT signed (no HMAC verification needed)
- Checkout acceptance ≠ payment success (must poll or receive webhook)
- Use £10.00 for success, £11.00 for decline (SumUp test amounts)
- Pairing code expires in 5 minutes
- Solo must be logged out to show pairing code
- Virtual Solo requires sandbox merchant credentials