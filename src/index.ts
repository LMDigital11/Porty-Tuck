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
      const apiKey = (normalized.apiConfig?.sumupApiKey || "").trim();
      const merchantCode = (normalized.apiConfig?.sumupMerchantCode || "").trim();

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

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, database: "d1" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
