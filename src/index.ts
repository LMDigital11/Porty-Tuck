// @ts-ignore - Import HTML as text
import html from "../index.html" with { type: "text" };

interface StoreDocument {
  version: number;
  users: any[];
  items: any[];
  sales: any[];
  stockEvents: any[];
  events: any[];
  lifetime: {
    revenue: number;
    cost: number;
    profit: number;
    sales: number;
    unitsSold: number;
  };
  meta: {
    createdAt: string;
    lastSelfDestructAt: string | null;
  };
}

interface Env {
  DB: D1Database;
}

const STORE_KEY = "tuck-shop-manager-v1";

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
    lifetime: {
      revenue: 0,
      cost: 0,
      profit: 0,
      sales: 0,
      unitsSold: 0,
    },
    meta: {
      createdAt: new Date().toISOString(),
      lastSelfDestructAt: null,
    },
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
    lifetime: {
      ...base.lifetime,
      ...(source.lifetime ?? {}),
    },
    meta: {
      ...base.meta,
      ...(source.meta ?? {}),
    },
  };

  return next;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, database: "d1" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
