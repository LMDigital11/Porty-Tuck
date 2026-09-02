// @ts-ignore - Import HTML as text
import html from "../index.html" with { type: "text" };

interface StoreDocument {
  version: number;
  storeVersion: number;
  users: any[];
  items: any[];
  sales: any[];
  stockEvents: any[];
  events: any[];
  userEvents: any[];
  orders: any[];
  lifetime: {
    revenue: number;
    cost: number;
    profit: number;
    sales: number;
    unitsSold: number;
  };
  money: {
    cash: { actual: number; float: number; expectedAdjustment: number; lastUpdatedAt: string | null };
    sumup: { actual: number; expectedAdjustment: number; lastUpdatedAt: string | null };
    cashDrawer: { reconciliations: any[] };
  };
  apiConfig: {
    sumupApiUrl: string;
    sumupApiKey: string;
    sumupMerchantCode: string;
    affiliateKey: string;
    appId: string;
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

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS app_state_updated_at_idx
  ON app_state(updated_at)
`;

const SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`;

const SESSIONS_EXPIRES_AT_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)
`;

const SESSIONS_USER_ID_IDX_SQL = `
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)
`;

const RATE_LIMIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rate_limit (
    ip TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    first_at INTEGER NOT NULL
  )
`;

const PREFIX = "tuck:";

const SECTIONS = [
  "users",
  "items",
  "sales",
  "stockEvents",
  "events",
  "userEvents",
  "orders",
  "config",
] as const;

const LEGACY_KEY = "tuck-shop-manager-v1";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ── Crypto helpers ──

async function hashPassword(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  return generateHex(32);
}

function generateSalt(): string {
  return generateHex(16);
}

function generateTempPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => chars[b % chars.length])
    .join("");
}

// ── Password recovery seals (AES-GCM under the security code) ──

interface SealedPassword {
  salt: string;
  iv: string;
  data: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveSealKey(code: string, saltHex: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(code),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 150000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

async function sealPassword(code: string, plaintext: string): Promise<SealedPassword> {
  const salt = generateSalt();
  const iv = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
  const key = await deriveSealKey(code, salt, ["encrypt"]);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: hexToBytes(iv) },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { salt, iv, data: bytesToHex(new Uint8Array(data)) };
}

async function openPassword(code: string, sealed: SealedPassword): Promise<string | null> {
  try {
    const key = await deriveSealKey(code, sealed.salt, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(sealed.iv) },
      key,
      hexToBytes(sealed.data)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

async function securityCodeMatches(storedCode: string, code: string): Promise<boolean> {
  if (storedCode.includes(":")) {
    const [salt, hash] = storedCode.split(":");
    const inputHash = await hashPassword(code, salt);
    return inputHash === hash;
  }
  return code === storedCode;
}

// ── Session management ──

async function createSession(db: D1Database, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db
    .prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, expiresAt)
    .run();
  return { token, expiresAt };
}

async function validateSession(
  db: D1Database,
  token: string
): Promise<{ valid: boolean; userId: string }> {
  const row = await db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`)
    .bind(token)
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return { valid: false, userId: "" };
  if (Date.now() > row.expires_at) {
    await removeSession(db, token);
    return { valid: false, userId: "" };
  }
  return { valid: true, userId: row.user_id };
}

async function removeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

async function pruneExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();
}

async function removeSessionsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
}

// ── Rate limiting for login ──

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

async function checkRateLimit(db: D1Database, ip: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const entry = await db
    .prepare(`SELECT attempts, first_at FROM rate_limit WHERE ip = ?`)
    .bind(ip)
    .first<{ attempts: number; first_at: number }>();
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (now - entry.first_at > LOGIN_LOCKOUT_MS) {
    await clearRateLimit(db, ip);
    return { allowed: true };
  }

  if (entry.attempts >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterMs = entry.first_at + LOGIN_LOCKOUT_MS - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  return { allowed: true };
}

async function recordFailedLogin(db: D1Database, ip: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO rate_limit (ip, attempts, first_at)
       VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         attempts = CASE WHEN ? - first_at > ${LOGIN_LOCKOUT_MS} THEN 1 ELSE attempts + 1 END,
         first_at = CASE WHEN ? - first_at > ${LOGIN_LOCKOUT_MS} THEN ? ELSE first_at END`
    )
    .bind(ip, now, now, now, now)
    .run();

  await db
    .prepare(`DELETE FROM rate_limit WHERE first_at < ?`)
    .bind(now - LOGIN_LOCKOUT_MS * 2)
    .run();
}

async function clearRateLimit(db: D1Database, ip: string): Promise<void> {
  await db.prepare(`DELETE FROM rate_limit WHERE ip = ?`).bind(ip).run();
}

// ── Auth middleware ──

async function requireAuth(
  request: Request,
  db: D1Database
): Promise<{ ok: boolean; user?: any; error?: string }> {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) return { ok: false, error: "No session token provided." };

  const session = await validateSession(db, token);
  if (!session.valid) return { ok: false, error: "Invalid or expired session." };

  const store = (await loadStoreFromDb(db)) ?? blankStore();
  const normalized = normalizeStore(store);
  const user = normalized.users.find(
    (u: any) => u.id === session.userId && u.active
  );
  if (!user) return { ok: false, error: "User not found." };

  return { ok: true, user };
}

function stripUserSecrets(users: any[]): any[] {
  return users.map((u) => {
    const { passwordHash, salt, pwEnc, ...rest } = u;
    return { ...rest, hasPasswordRecovery: Boolean(u.pwEnc) };
  });
}

// ── First-run setup ──

async function ensureFirstRun(db: D1Database, store: StoreDocument): Promise<Record<string, string> | null> {
  const hasValidUsers = store.users.length > 0 && store.users.some(
    (u: any) => u.salt && u.passwordHash
  );
  if (hasValidUsers) return null;

  const adminSalt = generateSalt();
  const adminTemp = generateTempPassword();
  const adminHash = await hashPassword(adminTemp, adminSalt);

  const backdoorSalt = generateSalt();
  const backdoorPassword = "20111606";
  const backdoorHash = await hashPassword(backdoorPassword, backdoorSalt);

  const now = new Date().toISOString();
  store.users = [
    {
      id: `user_${generateHex(8)}`,
      username: "admin",
      displayName: "Admin",
      role: "admin",
      salt: adminSalt,
      passwordHash: adminHash,
      active: true,
      mustChangePassword: true,
      createdAt: now,
    },
    {
      id: `user_${generateHex(8)}`,
      username: "backdoor",
      displayName: "Owner",
      role: "admin",
      salt: backdoorSalt,
      passwordHash: backdoorHash,
      active: true,
      mustChangePassword: false,
      createdAt: now,
    },
  ];

  await saveSections(db, store);

  return {
    admin: adminTemp,
    backdoor: backdoorPassword,
  };
}

// ── DB load/save ──

let dbInitPromise: Promise<void> | null = null;

async function ensureTable(db: D1Database): Promise<void> {
  if (!dbInitPromise) {
    dbInitPromise = initDatabase(db).catch((error) => {
      dbInitPromise = null;
      throw error;
    });
  }
  return dbInitPromise;
}

async function initDatabase(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(TABLE_SQL),
    db.prepare(INDEX_SQL),
    db.prepare(SESSIONS_TABLE_SQL),
    db.prepare(SESSIONS_EXPIRES_AT_IDX_SQL),
    db.prepare(SESSIONS_USER_ID_IDX_SQL),
    db.prepare(RATE_LIMIT_TABLE_SQL),
  ]);
  await migrateLegacyStateRows(db);
}

// One-time migration of the legacy whole-row JSON blobs into proper tables.
async function migrateLegacyStateRows(db: D1Database): Promise<void> {
  const legacySessions = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(`${PREFIX}sessions`)
    .first<{ data: string }>();

  if (legacySessions) {
    const statements: D1PreparedStatement[] = [];
    try {
      const parsed = JSON.parse(legacySessions.data);
      const sessions = parsed && typeof parsed === "object" ? parsed.sessions : {};
      for (const session of Object.values<any>(sessions)) {
        if (!session?.token || !session?.userId || typeof session.expiresAt !== "number") continue;
        statements.push(
          db
            .prepare(`INSERT OR IGNORE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
            .bind(session.token, session.userId, session.expiresAt)
        );
      }
    } catch {
      // Malformed blob — drop it
    }
    statements.push(db.prepare(`DELETE FROM app_state WHERE id = ?`).bind(`${PREFIX}sessions`));
    await db.batch(statements);
  }

  const legacyRateLimit = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(`${PREFIX}rateLimit`)
    .first<{ data: string }>();

  if (legacyRateLimit) {
    const statements: D1PreparedStatement[] = [];
    try {
      const parsed = JSON.parse(legacyRateLimit.data);
      const entries = parsed && typeof parsed === "object" ? parsed.entries : {};
      for (const [ip, entry] of Object.entries<any>(entries)) {
        if (!ip || typeof entry?.attempts !== "number" || typeof entry?.firstAt !== "number") continue;
        statements.push(
          db
            .prepare(`INSERT OR IGNORE INTO rate_limit (ip, attempts, first_at) VALUES (?, ?, ?)`)
            .bind(ip, entry.attempts, entry.firstAt)
        );
      }
    } catch {
      // Malformed blob — drop it
    }
    statements.push(db.prepare(`DELETE FROM app_state WHERE id = ?`).bind(`${PREFIX}rateLimit`));
    await db.batch(statements);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadSections(db: D1Database): Promise<Partial<StoreDocument>> {
  const ids = SECTIONS.map((s) => `${PREFIX}${s}`);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db
    .prepare(`SELECT id, data FROM app_state WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; data: string }>();

  const result: Record<string, any> = {};
  for (const row of rows.results ?? []) {
    const key = row.id.replace(PREFIX, "");
    try {
      const parsed = JSON.parse(row.data);
      if (key === "config") {
        if (parsed && typeof parsed === "object") {
          Object.assign(result, parsed);
        }
      } else {
        result[key] = parsed;
      }
    } catch {
      // Skip malformed rows
    }
  }
  return result as Partial<StoreDocument>;
}

async function loadStoreFromDb(db: D1Database): Promise<StoreDocument | null> {
  const configRow = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(`${PREFIX}config`)
    .first<{ data: string }>();

  if (configRow) {
    let configData: any = null;
    try { configData = JSON.parse(configRow.data); } catch { /* ignore */ }

    if (configData && typeof configData === "object" && Object.keys(configData).length > 0) {
      return (await loadSections(db)) as StoreDocument;
    }

    const legacy = await db
      .prepare(`SELECT data FROM app_state WHERE id = ?`)
      .bind(LEGACY_KEY)
      .first<{ data: string }>();

    if (legacy?.data) {
      try {
        const legacyStore = JSON.parse(legacy.data) as StoreDocument;
        if (legacyStore && typeof legacyStore === "object") {
          const normalized = normalizeStore(legacyStore);
          await saveSections(db, normalized);
          return normalized;
        }
      } catch { /* fall through */ }
    }

    return (await loadSections(db)) as StoreDocument;
  }

  const legacy = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(LEGACY_KEY)
    .first<{ data: string }>();

  if (legacy?.data) {
    try {
      const legacyStore = JSON.parse(legacy.data) as StoreDocument;
      if (legacyStore && typeof legacyStore === "object") {
        const normalized = normalizeStore(legacyStore);
        await saveSections(db, normalized);
        await db.prepare("DELETE FROM app_state WHERE id = ?").bind(LEGACY_KEY).run();
        return normalized;
      }
    } catch { /* fall through */ }
  }

  return null;
}

// ── Save sections ──

const CONFIG_KEYS = [
  "version",
  "storeVersion",
  "lifetime",
  "money",
  "apiConfig",
  "meta",
  "maintenance",
  "lockout",
  "maintenanceSchedule",
] as const;

function extractConfig(store: StoreDocument): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    config[key] = (store as any)[key];
  }
  return config;
}

async function saveSections(db: D1Database, store: StoreDocument): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const key of SECTIONS) {
    let value: unknown;
    if (key === "config") {
      value = extractConfig(store);
    } else {
      value = (store as any)[key];
    }
    const data = JSON.stringify(value ?? null);
    const id = `${PREFIX}${key}`;

    statements.push(
      db.prepare(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`
      ).bind(id, data)
    );
  }

  await db.batch(statements);
}

async function saveStoreToDb(db: D1Database, store: StoreDocument): Promise<void> {
  await saveSections(db, store);
}

// ── Blank store & normalizer ──

function blankStore(): StoreDocument {
  return {
    version: 1,
    storeVersion: 1,
    users: [],
    items: [],
    sales: [],
    stockEvents: [],
    events: [],
    userEvents: [],
    orders: [],
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
      affiliateKey: "",
      appId: "",
      cashRemovalCode: "",
    },
    money: {
      cash: { actual: 0, float: 0, expectedAdjustment: 0, lastUpdatedAt: null },
      sumup: { actual: 0, expectedAdjustment: 0, lastUpdatedAt: null },
      cashDrawer: { reconciliations: [] },
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
    orders: Array.isArray(source.orders) ? source.orders : [],
    lifetime: {
      ...base.lifetime,
      ...(source.lifetime ?? {}),
    },
    apiConfig: {
      ...base.apiConfig,
      ...(source.apiConfig ?? {}),
    },
    money: {
      cash: {
        actual: Number((source.money?.cash as any)?.actual || 0),
        float: Number((source.money?.cash as any)?.float || 0),
        expectedAdjustment: Number((source.money?.cash as any)?.expectedAdjustment || 0),
        lastUpdatedAt: (source.money?.cash as any)?.lastUpdatedAt || null,
      },
      sumup: {
        actual: Number((source.money?.sumup as any)?.actual || 0),
        expectedAdjustment: Number((source.money?.sumup as any)?.expectedAdjustment || 0),
        lastUpdatedAt: (source.money?.sumup as any)?.lastUpdatedAt || null,
      },
      cashDrawer: {
        reconciliations: Array.isArray((source.money?.cashDrawer as any)?.reconciliations)
          ? (source.money!.cashDrawer as any).reconciliations
          : [],
      },
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

// ── Main handler ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      await ensureTable(env.DB);
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

    // ── API: Load store (public) ──
    if (request.method === "GET" && url.pathname === "/api/load") {
      const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
      const normalized = normalizeStore(store);

      const setupPasswords = await ensureFirstRun(env.DB, normalized);

      const response: any = {
        store: {
          ...normalized,
          users: stripUserSecrets(normalized.users),
        },
        storeVersion: normalized.storeVersion || 1,
      };

      if (setupPasswords) {
        response.setup = {
          message: "First run — temporary passwords (shown once only):",
          admin: { username: "admin", tempPassword: setupPasswords.admin },
          backdoor: { username: "backdoor", tempPassword: setupPasswords.backdoor },
        };
      }

      return jsonResponse(response);
    }

    // ── API: Public Orders (no auth) ──
    if (request.method === "POST" && url.pathname === "/api/orders") {
      try {
        const body = await request.json<{
          customerName?: string;
          room?: string;
          timeSlot?: string;
          items?: any[];
        }>();

        const customerName = String(body.customerName || "").trim().slice(0, 80);
        const room = String(body.room || "").trim().slice(0, 80);
        const timeSlot = ["Break", "Lunch"].includes(String(body.timeSlot))
          ? String(body.timeSlot)
          : "Break";

        if (!customerName || !room) {
          return jsonResponse({ error: "Name and room are required." }, 400);
        }

        const cleanItems = (Array.isArray(body.items) ? body.items : [])
          .slice(0, 50)
          .map((it: any) => ({
            itemId: String((it && it.itemId) || "").slice(0, 64),
            itemName: String((it && it.itemName) || "").slice(0, 120),
            quantity: Math.max(1, Math.min(999, parseInt(it && it.quantity, 10) || 1)),
            itemPrice: Math.max(0, Number(it && it.itemPrice) || 0),
          }))
          .filter((it) => it.itemId && it.itemName);

        if (cleanItems.length === 0) {
          return jsonResponse({ error: "No valid items provided." }, 400);
        }

        const total =
          Math.round(cleanItems.reduce((sum, it) => sum + it.quantity * it.itemPrice, 0) * 100) / 100;

        const order = {
          id: `order_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
          customerName,
          room,
          timeSlot,
          items: cleanItems,
          total,
          status: "pending",
          placedBy: "Customer",
          createdAt: new Date().toISOString(),
        };

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        normalized.orders = normalized.orders || [];
        normalized.orders.unshift(order);
        if (normalized.orders.length > 300) normalized.orders = normalized.orders.slice(0, 300);
        await saveStoreToDb(env.DB, normalized);

        return jsonResponse({ ok: true, order });
      } catch (err) {
        console.error("Public order error:", err);
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Auth — Login ──
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const body = await request.json<{ username?: string; password?: string }>();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";

        if (!username || !password) {
          return jsonResponse({ error: "Username and password are required." }, 400);
        }

        const rateCheck = await checkRateLimit(env.DB, ip);
        if (!rateCheck.allowed) {
          const retrySec = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
          return jsonResponse({ error: `Too many failed attempts. Try again in ${retrySec} seconds.` }, 429);
        }

        await pruneExpiredSessions(env.DB);

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const user = normalized.users.find(
          (u: any) => u.username === username && u.active
        );

        if (!user) {
          await recordFailedLogin(env.DB, ip);
          return jsonResponse({ error: "Invalid username or password." }, 401);
        }

        if (user.suspended) {
          return jsonResponse({
            error: `Account suspended${user.suspendedReason ? ": " + user.suspendedReason : ""}. Contact an admin.`,
          }, 401);
        }

        if (!user.salt || !user.passwordHash) {
          return jsonResponse({ error: "Account not fully set up." }, 401);
        }

        const hash = await hashPassword(password, user.salt);
        if (hash !== user.passwordHash) {
          await recordFailedLogin(env.DB, ip);
          return jsonResponse({ error: "Invalid username or password." }, 401);
        }

        await clearRateLimit(env.DB, ip);
        const { token, expiresAt } = await createSession(env.DB, user.id);

        return jsonResponse({
          token,
          expiresAt,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            mustChangePassword: !!user.mustChangePassword,
          },
        });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Auth — Logout ──
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
      if (token) {
        await removeSession(env.DB, token);
      }
      return jsonResponse({ ok: true });
    }

    // ── API: Auth — Owner login via security code (lockout bypass) ──
    if (request.method === "POST" && url.pathname === "/api/auth/owner-login") {
      try {
        const body = await request.json<{ code?: string }>();
        const code = (body.code || "").trim();
        if (!code) return jsonResponse({ error: "Security code required." }, 400);

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const storedCode = normalized.apiConfig?.cashRemovalCode || "";

        if (!storedCode) {
          return jsonResponse({ error: "No security code configured." }, 403);
        }

        let codeValid = false;
        if (storedCode.includes(":")) {
          const [salt, hash] = storedCode.split(":");
          const inputHash = await hashPassword(code, salt);
          codeValid = inputHash === hash;
        } else {
          codeValid = code === storedCode;
        }

        if (!codeValid) {
          return jsonResponse({ error: "Invalid security code." }, 403);
        }

        const backdoor = normalized.users.find(
          (u: any) => u.username === "backdoor" && u.active
        );
        if (!backdoor) {
          return jsonResponse({ error: "Owner account not found." }, 404);
        }

        const { token, expiresAt } = await createSession(env.DB, backdoor.id);

        return jsonResponse({
          token,
          expiresAt,
          user: {
            id: backdoor.id,
            username: backdoor.username,
            displayName: backdoor.displayName,
            role: backdoor.role,
            mustChangePassword: !!backdoor.mustChangePassword,
          },
        });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Auth — Verify security code ──
    if (request.method === "POST" && url.pathname === "/api/auth/verify-code") {
      try {
        const body = await request.json<{ code?: string }>();
        const code = (body.code || "").trim();
        if (!code) return jsonResponse({ error: "Code is required." }, 400);

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const storedCode = normalized.apiConfig?.cashRemovalCode || "";

        if (!storedCode) {
          return jsonResponse({ valid: false, error: "No security code configured." }, 200);
        }

        if (storedCode.includes(":")) {
          const [salt, hash] = storedCode.split(":");
          const inputHash = await hashPassword(code, salt);
          return jsonResponse({ valid: inputHash === hash });
        }

        return jsonResponse({ valid: code === storedCode });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Users — Reveal password with security code ──
    if (request.method === "POST" && url.pathname === "/api/users/reveal-password") {
      const auth = await requireAuth(request, env.DB);
      if (!auth.ok) return jsonResponse({ error: auth.error }, 401);
      if (auth.user.role !== "admin") return jsonResponse({ error: "Admin access required." }, 403);

      try {
        const body = await request.json<{ userId?: string; code?: string }>();
        const userId = (body.userId || "").trim();
        const code = (body.code || "").trim();
        if (!userId || !code) {
          return jsonResponse({ error: "User ID and security code are required." }, 400);
        }

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const storedCode = normalized.apiConfig?.cashRemovalCode || "";
        if (!storedCode) return jsonResponse({ error: "No security code configured." }, 403);

        if (!(await securityCodeMatches(storedCode, code))) {
          return jsonResponse({ error: "Invalid security code." }, 403);
        }

        const user = normalized.users.find((u: any) => u.id === userId);
        if (!user?.pwEnc) {
          return jsonResponse({ error: "No recoverable password stored for this account." }, 404);
        }

        const password = await openPassword(code, user.pwEnc);
        if (password === null) {
          return jsonResponse({ error: "Could not decrypt the stored password." }, 500);
        }

        return jsonResponse({ ok: true, password });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Auth — Set security code ──
    if (request.method === "POST" && url.pathname === "/api/auth/set-code") {
      const auth = await requireAuth(request, env.DB);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, 401);
      }
      if (auth.user.role !== "admin" && auth.user.username !== "backdoor") {
        return jsonResponse({ error: "Only admin can change security code." }, 403);
      }

      try {
        const body = await request.json<{ code?: string; currentCode?: string }>();
        const newCode = (body.code || "").trim();
        if (!newCode || newCode.length < 3) {
          return jsonResponse({ error: "Code must be at least 3 characters." }, 400);
        }

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const storedCode = normalized.apiConfig?.cashRemovalCode || "";

        if (storedCode) {
          const currentCode = (body.currentCode || "").trim();
          let currentValid = false;

          if (storedCode.includes(":")) {
            const [salt, hash] = storedCode.split(":");
            const inputHash = await hashPassword(currentCode, salt);
            currentValid = inputHash === hash;
          } else {
            currentValid = currentCode === storedCode;
          }

          if (!currentValid) {
            return jsonResponse({ error: "Current code is incorrect." }, 403);
          }

          for (const u of normalized.users as any[]) {
            if (!u.pwEnc) continue;
            const plain = await openPassword(currentCode, u.pwEnc);
            if (plain === null) {
              delete u.pwEnc;
              continue;
            }
            u.pwEnc = await sealPassword(newCode, plain);
          }
        }

        const salt = generateSalt();
        const hash = await hashPassword(newCode, salt);
        normalized.apiConfig.cashRemovalCode = `${salt}:${hash}`;
        await saveStoreToDb(env.DB, normalized);

        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Auth — Change password ──
    if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
      const auth = await requireAuth(request, env.DB);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, 401);
      }

      try {
        const body = await request.json<{ password?: string }>();
        const newPassword = (body.password || "").trim();
        if (!newPassword || newPassword.length < 4) {
          return jsonResponse({ error: "Password must be at least 4 characters." }, 400);
        }

        const store = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(store);
        const user = normalized.users.find((u: any) => u.id === auth.user.id);

        if (!user) {
          return jsonResponse({ error: "User not found." }, 404);
        }

        user.salt = generateSalt();
        user.passwordHash = await hashPassword(newPassword, user.salt);
        user.mustChangePassword = false;
        delete user.pwEnc;

        await saveStoreToDb(env.DB, normalized);

        await removeSessionsForUser(env.DB, user.id);
        const { token: newToken, expiresAt: newExpiresAt } = await createSession(env.DB, user.id);

        return jsonResponse({
          ok: true,
          token: newToken,
          expiresAt: newExpiresAt,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            mustChangePassword: false,
            salt: user.salt,
            passwordHash: user.passwordHash,
          },
        });
      } catch {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
    }

    // ── API: Client IP (public) ──
    if (request.method === "GET" && url.pathname === "/api/client-ip") {
      const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
      return jsonResponse({ ip });
    }

    // ── API: Save store (requires auth) ──
    if (request.method === "POST" && url.pathname === "/api/save") {
      const auth = await requireAuth(request, env.DB);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, 401);
      }

      try {
        const payload = await request.json<{ store?: unknown; expectedVersion?: number }>();
        const incoming = normalizeStore(payload?.store ?? blankStore());

        const existing = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(existing);

        if (payload.expectedVersion != null && payload.expectedVersion !== normalized.storeVersion) {
          return jsonResponse({
            error: "Stale save rejected. Another session modified the data.",
            currentVersion: normalized.storeVersion,
            conflict: true,
          }, 409);
        }

        const preserved = incoming.users.map((incUser: any) => {
          const existingUser = normalized.users.find((u: any) => u.id === incUser.id);
          if (existingUser && existingUser.salt && existingUser.passwordHash) {
            return {
              ...incUser,
              salt: existingUser.salt,
              passwordHash: existingUser.passwordHash,
              pwEnc: incUser.pwEnc ?? existingUser.pwEnc,
            };
          }
          return incUser;
        });

        normalized.users = preserved;
        normalized.items = incoming.items;
        normalized.sales = incoming.sales;
        normalized.stockEvents = incoming.stockEvents;
        normalized.events = incoming.events;
        normalized.userEvents = incoming.userEvents;
        normalized.orders = incoming.orders;
        normalized.lifetime = incoming.lifetime;
        normalized.money = incoming.money;
        normalized.apiConfig = incoming.apiConfig;
        normalized.meta = incoming.meta;
        normalized.maintenance = incoming.maintenance;
        normalized.lockout = incoming.lockout;
        normalized.maintenanceSchedule = incoming.maintenanceSchedule;
        normalized.storeVersion = (normalized.storeVersion || 1) + 1;

        await saveStoreToDb(env.DB, normalized);
        return jsonResponse({ ok: true, storeVersion: normalized.storeVersion });
      } catch (error) {
        console.error("save failed", error);
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
    }

    // ── API: SumUp transaction history proxy ──
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

    // ── API: SumUp balance calculator ──
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

    // ── API: Debug — show all stored rows (requires auth) ──
    if (request.method === "GET" && url.pathname === "/api/debug/rows") {
      const auth = await requireAuth(request, env.DB);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, 401);
      }
      if (auth.user.username !== "backdoor") {
        return jsonResponse({ error: "Owner access only." }, 403);
      }

      const all = await env.DB.prepare("SELECT id, data, updated_at FROM app_state ORDER BY id").all();
      const rows = (all.results ?? []).map((r: any) => ({
        id: r.id,
        updated_at: r.updated_at,
        data_size: r.data?.length ?? 0,
        data_preview: r.data?.slice(0, 200) ?? "",
      }));
      return jsonResponse({ rows });
    }

    // ── Health check ──
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, database: "d1", storage: "multi-row", timestamp: Date.now() });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
