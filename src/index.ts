// @ts-ignore - Import HTML as text
import html from "../index.html" with { type: "text" };

interface StoreDocument {
  version: number;
  users: any[];
  items: any[];
  sales: any[];
  stockEvents: any[];
  events: any[];
  userEvents: any[];
  lifetime: {
    revenue: number;
    cost: number;
    profit: number;
    sales: number;
    unitsSold: number;
  };
  apiConfig: {
    sumupApiUrl: string;
    sumupApiKey: string;
    sumupMerchantCode: string;
    cashRemovalCode: string;
  };
  meta: {
    createdAt: string;
    lastSelfDestructAt: string | null;
  };
  maintenance: {
    active: boolean;
    resumeAt: string | null;
    reason: string;
    startedBy: string | null;
    scheduledAt: string | null;
  };
  lockout: {
    active: boolean;
    reason: string;
    startedBy: string | null;
  };
  maintenanceSchedule: any[];
}

interface Env {
  DB: D1Database;
}

const STORE_KEY = "tuck-shop-manager-v1";

const APP_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

const APP_STATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS app_state_updated_at_idx
  ON app_state(updated_at)
`;

async function ensureAppStateTable(db: D1Database): Promise<void> {
  await db.prepare(APP_STATE_TABLE_SQL).run();
  await db.prepare(APP_STATE_INDEX_SQL).run();
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadStoreFromDb(db: D1Database): Promise<StoreDocument | null> {
  const row = await db
    .prepare("SELECT data FROM app_state WHERE id = ?")
    .bind(STORE_KEY)
    .first<{ data: string }>();

  if (!row?.data) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.data) as StoreDocument;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveStoreToDb(db: D1Database, store: StoreDocument): Promise<void> {
  const payload = JSON.stringify(store);
  const existing = await db
    .prepare("SELECT 1 FROM app_state WHERE id = ?")
    .bind(STORE_KEY)
    .first();

  if (existing) {
    await db
      .prepare("UPDATE app_state SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(payload, STORE_KEY)
      .run();
    return;
  }

  await db
    .prepare("INSERT INTO app_state (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .bind(STORE_KEY, payload)
    .run();
}

function blankStore(): StoreDocument {
  return {
    version: 1,
    users: [],
    items: [],
    sales: [],
    stockEvents: [],
    events: [],
    userEvents: [],
    lifetime: {
      revenue: 0,
      cost: 0,
      profit: 0,
      sales: 0,
      unitsSold: 0,
    },
    apiConfig: {
      sumupApiUrl: "",
      sumupApiKey: "",
      sumupMerchantCode: "",
      cashRemovalCode: "CASHOUT",
    },
    meta: {
      createdAt: new Date().toISOString(),
      lastSelfDestructAt: null,
    },
    maintenance: {
      active: false,
      resumeAt: null,
      reason: "",
      startedBy: null,
      scheduledAt: null,
    },
    lockout: {
      active: false,
      reason: "",
      startedBy: null,
    },
    maintenanceSchedule: [],
  };
}

function normalizeStore(store: unknown): StoreDocument {
  const source = store && typeof store === "object" ? (store as Partial<StoreDocument>) : {};
  const base = blankStore();

  const next: StoreDocument = {
    ...base,
    ...source,
    users: Array.isArray(source.users) ? source.users : [],
    items: Array.isArray(source.items) ? source.items : [],
    sales: Array.isArray(source.sales) ? source.sales : [],
    stockEvents: Array.isArray(source.stockEvents) ? source.stockEvents : [],
    events: Array.isArray(source.events) ? source.events : [],
    userEvents: Array.isArray(source.userEvents) ? source.userEvents : [],
    lifetime: {
      ...base.lifetime,
      ...(source.lifetime ?? {}),
    },
    apiConfig: {
      ...base.apiConfig,
      ...(source.apiConfig ?? {}),
    },
    meta: {
      ...base.meta,
      ...(source.meta ?? {}),
    },
    maintenance: {
      ...base.maintenance,
      ...(source.maintenance ?? {}),
    },
    lockout: {
      ...base.lockout,
      ...(source.lockout ?? {}),
    },
    maintenanceSchedule: Array.isArray(source.maintenanceSchedule) ? source.maintenanceSchedule : [],
  };

  return next;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      await ensureAppStateTable(env.DB);
    } catch (error) {
      console.error("Failed to initialize app_state table:", error);
      return jsonResponse({ error: "Database initialization failed" }, 500);
    }

    // Serve the HTML at root and /index.html
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // API endpoints remain unchanged (no /api prefix needed, app already uses /api in code)
    if (request.method === "GET" && url.pathname === "/api/load") {
      const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
      return jsonResponse({ store: normalizeStore(store) });
    }

    if (request.method === "POST" && url.pathname === "/api/save") {
      try {
        const payload = await request.json<{ store?: unknown }>();
        const normalized = normalizeStore(payload?.store ?? blankStore());
        await saveStoreToDb(env.DB, normalized);
        return jsonResponse({ ok: true, store: normalized });
      } catch (error) {
        console.error("save failed", error);
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
    }

    // Client IP endpoint (for user event logging)
    if (request.method === "GET" && url.pathname === "/api/client-ip") {
      const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
      return jsonResponse({ ip });
    }

    // SumUp transaction history proxy (avoids browser CORS)
    if (request.method === "GET" && url.pathname === "/api/sumup/transactions") {
      const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
      const normalized = normalizeStore(store);
      const apiKey = (url.searchParams.get("api_key") || normalized.apiConfig?.sumupApiKey || "").trim();
      const merchantCode = (url.searchParams.get("merchant_code") || normalized.apiConfig?.sumupMerchantCode || "").trim();

      if (!apiKey || !merchantCode) {
        return jsonResponse({ error: "SumUp API key or merchant code not configured." }, 400);
      }

      const oldestTime = url.searchParams.get("oldest_time") || "";
      const sumupUrl = new URL(`https://api.sumup.com/v2.1/merchants/${merchantCode}/transactions/history`);
      if (oldestTime) {
        sumupUrl.searchParams.set("oldest_time", oldestTime);
      }

      try {
        const response = await fetch(sumupUrl.toString(), {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
        });

        const body = await response.text();
        return new Response(body, {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("SumUp proxy error:", error);
        return jsonResponse({ error: "Failed to reach SumUp API." }, 502);
      }
    }

    // SumUp balance calculator (transactions + payouts)
    if (request.method === "GET" && url.pathname === "/api/sumup/balance") {
      const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
      const normalized = normalizeStore(store);
      const apiKey = (normalized.apiConfig?.sumupApiKey || "").trim();
      const merchantCode = (normalized.apiConfig?.sumupMerchantCode || "").trim();

      if (!apiKey || !merchantCode) {
        return jsonResponse({ error: "SumUp API key or merchant code not configured." }, 400);
      }

      const headers = {
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      };

      try {
        // Fetch all transactions via pagination
        const allTx: any[] = [];
        let txUrl: string | null = `https://api.sumup.com/v2.1/merchants/${merchantCode}/transactions/history?limit=100&order=descending`;
        let txPages = 0;

        while (txUrl && txPages < 50) {
          const resp = await fetch(txUrl, { method: "GET", headers });
          if (!resp.ok) {
            const errBody = await resp.text();
            return jsonResponse({ error: `SumUp transactions API returned ${resp.status}: ${errBody}` }, 502);
          }
          const data = await resp.json<{ items?: any[]; links?: any[] }>();
          if (Array.isArray(data.items)) {
            allTx.push(...data.items);
          }
          const nextLink = Array.isArray(data.links)
            ? data.links.find((l: any) => l.rel === "next")
            : null;
          txUrl = nextLink
            ? `https://api.sumup.com/v2.1/merchants/${merchantCode}/transactions/history?${nextLink.href}`
            : null;
          txPages++;
        }

        // Fetch payouts for the last 2 years
        const now = new Date();
        const twoYearsAgo = new Date(now);
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        const payoutStartDate = twoYearsAgo.toISOString().split("T")[0];
        const payoutEndDate = now.toISOString().split("T")[0];

        let payouts: any[] = [];
        try {
          const payoutResp = await fetch(
            `https://api.sumup.com/v1.0/merchants/${merchantCode}/payouts?start_date=${payoutStartDate}&end_date=${payoutEndDate}&limit=9999&order=desc`,
            { method: "GET", headers }
          );
          if (payoutResp.ok) {
            payouts = await payoutResp.json<any[]>();
            if (!Array.isArray(payouts)) payouts = [];
          }
        } catch {
          payouts = [];
        }

        // Calculate balance breakdown
        let grossSales = 0;
        let refunds = 0;
        let chargebacks = 0;

        for (const tx of allTx) {
          const amount = Number(tx.amount || 0);
          const type = String(tx.type || "").toUpperCase();
          const status = String(tx.status || "").toUpperCase();

          if (type === "PAYMENT" && status === "SUCCESSFUL") {
            grossSales += amount;
          } else if (type === "REFUND") {
            refunds += amount;
          } else if (type === "CHARGE_BACK") {
            chargebacks += amount;
          }
        }

        let totalPayouts = 0;
        let totalFees = 0;
        let payoutDeductions = 0;

        for (const p of payouts) {
          const amount = Number(p.amount || 0);
          const fee = Number(p.fee || 0);
          const pType = String(p.type || "").toUpperCase();
          const pStatus = String(p.status || "").toUpperCase();

          if (pType === "PAYOUT" && pStatus === "SUCCESSFUL") {
            totalPayouts += amount;
            totalFees += fee;
          } else if (pType === "REFUND_DEDUCTION" || pType === "CHARGE_BACK_DEDUCTION" || pType === "DD_RETURN_DEDUCTION" || pType === "BALANCE_DEDUCTION") {
            payoutDeductions += amount;
          }
        }

        const pendingBalance = Math.round((grossSales - refunds - chargebacks - totalFees - totalPayouts) * 100) / 100;

        return jsonResponse({
          grossSales: Math.round(grossSales * 100) / 100,
          refunds: Math.round(refunds * 100) / 100,
          chargebacks: Math.round(chargebacks * 100) / 100,
          fees: Math.round(totalFees * 100) / 100,
          payouts: Math.round(totalPayouts * 100) / 100,
          payoutDeductions: Math.round(payoutDeductions * 100) / 100,
          pendingBalance,
          transactionCount: allTx.length,
          payoutCount: payouts.length,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error("SumUp balance calc error:", error);
        return jsonResponse({ error: "Failed to calculate SumUp balance." }, 502);
      }
    }

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, database: "d1" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
