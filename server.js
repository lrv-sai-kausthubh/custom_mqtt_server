require("dotenv").config();

const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const http = require("http");
const path = require("path");
const mqtt = require("mqtt");
const cors = require("cors");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

function tableName(value, fallback) {
  const name = value || fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name configured: ${name}`);
  }
  return name;
}

const USERS_TABLE = tableName(process.env.SUPABASE_USERS_TABLE, "app_users");
const SESSIONS_TABLE = tableName(process.env.SUPABASE_SESSIONS_TABLE, "app_sessions");

const SESSION_DAYS = Math.min(Math.max(Number(process.env.AUTH_SESSION_DAYS) || 7, 1), 30);
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const SCRYPT_KEY_LENGTH = 64;

function required(name, value) {
  if (!value) throw new Error(`${name} must be configured in .env`);
}

required("SUPABASE_URL", SUPABASE_URL);
required("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY);
required("MQTT_USERNAME", MQTT_USERNAME);
required("MQTT_PASSWORD", MQTT_PASSWORD);

// ---------------------------------------------------------------
// Console logging
// ---------------------------------------------------------------
// Set LOG_LEVEL=debug in .env to also see Socket.IO polling requests,
// successful auth checks, and suppressed duplicate MQTT messages.
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, none: 100 };
const LOG_LEVEL_NAME = String(process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVEL = Object.prototype.hasOwnProperty.call(LOG_LEVELS, LOG_LEVEL_NAME)
  ? LOG_LEVELS[LOG_LEVEL_NAME]
  : LOG_LEVELS.info;

function logTimestamp() {
  return new Date().toISOString();
}

function logValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value === "") return '""';
    const cleaned = value.replace(/[\r\n\t]+/g, " ");
    return /[\s"=]/.test(cleaned) ? JSON.stringify(cleaned) : cleaned;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function writeLog(level, event, details = {}) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const parts = [`[${logTimestamp()}]`, level.toUpperCase().padEnd(5), event];
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) parts.push(`${key}=${logValue(value)}`);
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function logDebug(event, details) {
  writeLog("debug", event, details);
}

function logInfo(event, details) {
  writeLog("info", event, details);
}

function logWarn(event, details) {
  writeLog("warn", event, details);
}

function logError(event, details) {
  writeLog("error", event, details);
}

function previewText(value, maxLength = 200) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(${text.length} chars)`;
}

function requestIp(req) {
  const headers = req.headers || {};
  const cfIp = headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  try {
    if (req.ip) return req.ip;
  } catch (_error) {
    // Fall through to the socket address.
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function socketIp(socket) {
  const headers = socket.handshake.headers || {};
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  const cfIp = headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();
  return socket.handshake.address || "unknown";
}

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch (_error) {
    return String(value);
  }
}

function userLabel(user) {
  if (!user) return "anonymous";
  return user.email || user.id || "unknown";
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");

const app = express();
const server = http.createServer(app);
// The Cloudflare Tunnel connects from loopback, so its forwarded client IP is trusted.
app.set("trust proxy", "loopback");

// Attach a short request id early so auth logs and the access log line can be
// matched together.
app.use((req, _res, next) => {
  req.logId = req.logId || crypto.randomBytes(4).toString("hex");
  next();
});

const socketOptions = {};
if (allowAllOrigins) {
  socketOptions.cors = { origin: true, methods: ["GET", "POST"] };
} else if (allowedOrigins.length > 0) {
  socketOptions.cors = { origin: allowedOrigins, methods: ["GET", "POST"] };
}
const io = new Server(server, socketOptions);

// Supabase is used only as a database. There is no Supabase Auth or Supabase email flow.
// This client exists only on the backend. Never send the service-role key to a browser.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

if (allowAllOrigins) {
  app.use(
    cors({
      origin: true,
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
} else if (allowedOrigins.length > 0) {
  app.use(
    cors({
      origin(origin, callback) {
        // Requests from curl/PowerShell have no Origin header. Browser origins
        // that are not allowlisted simply receive no CORS headers, so the
        // browser blocks them. Same-origin requests still work.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
}

app.use(express.json({ limit: "16kb" }));

// Log every HTTP request that reaches this machine, including Cloudflare-
// forwarded API calls, static files, and Socket.IO polling transports.
server.on("request", (req, res) => {
  const startedAt = process.hrtime.bigint();
  req.logId = req.logId || crypto.randomBytes(4).toString("hex");
  const isSocketIo = (req.url || "").startsWith("/socket.io/");
  let finished = false;

  const writeRequestLog = (event) => {
    if (finished) return;
    finished = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const identity = req.identity && req.identity.user;
    const details = {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      bytes: res.getHeader("content-length") || undefined,
      ip: requestIp(req),
      user: userLabel(identity),
      userId: identity ? identity.id : undefined,
      origin: req.headers.origin || "-",
      ua: previewText(req.headers["user-agent"] || "-", 120),
    };
    if (isSocketIo) logDebug(event, details);
    else logInfo(event, details);
  };

  res.on("finish", () => writeRequestLog("http_request"));
  res.on("close", () => {
    if (!res.writableEnded) writeRequestLog("http_request_aborted");
  });
});

// Serve the login page and dashboard from the same origin as this API.
app.use(express.static(PUBLIC_DIR));

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return (
    email.length > 3 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

const DEFAULT_TOPIC_FILTER = "home/#";

// MQTT topic filters used by the radio tuner. Only the home/ namespace is
// allowed, with normal MQTT wildcard rules (+ = one level, # = the rest).
function isValidTopicFilter(filter) {
  if (typeof filter !== "string") return false;
  const topic = filter.trim();
  if (topic.length < 6 || topic.length > 128) return false;
  if (!/^home\/[A-Za-z0-9_/+#-]+$/.test(topic)) return false;
  if (topic.includes("//") || topic.endsWith("/")) return false;

  const levels = topic.split("/");
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i];
    if (level === "#") {
      if (i !== levels.length - 1) return false;
    } else if (level.includes("#") || (level.includes("+") && level !== "+")) {
      return false;
    }
  }
  return true;
}

// MQTT wildcard matching, including the special case where "home/#" also
// matches the parent "home" level.
function topicMatchesFilter(filter, topic) {
  if (filter === "#") return true;
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");

  for (let i = 0; i < filterLevels.length; i += 1) {
    const level = filterLevels[i];
    if (level === "#") return true;
    if (i >= topicLevels.length) return false;
    if (level !== "+" && level !== topicLevels[i]) return false;
  }
  return filterLevels.length === topicLevels.length;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], "base64url");
    expected = Buffer.from(parts[2], "base64url");
  } catch (_error) {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEY_LENGTH) return false;

  const actual = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return crypto.timingSafeEqual(expected, actual);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Small in-memory throttles for our own auth endpoints. This is independent of
// Supabase. It counts failed sign-ins and newly created accounts, so normal use
// is not affected.
const authFailures = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authFailures) {
    if (entry.resetAt <= now) authFailures.delete(key);
  }
}, 10 * 60 * 1000).unref();

function authKey(req, scope, email = "") {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  return `${scope}:${ip}:${email}`;
}

function isThrottled(key, max) {
  const entry = authFailures.get(key);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= max);
}

function recordFailure(key, windowMs) {
  const now = Date.now();
  const entry = authFailures.get(key);
  if (!entry || entry.resetAt <= now) {
    authFailures.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
}

function clearFailures(key) {
  authFailures.delete(key);
}

async function loadUserById(userId) {
  const { data, error } = await supabaseAdmin
    .from(USERS_TABLE)
    .select("id, email, status, role, created_at, reviewed_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    logError("database_read_user_failed", { userId, error: error.message });
    throw httpError(503, "Could not read the account record.");
  }
  return data || null;
}

async function deleteSessionByToken(token) {
  const { error } = await supabaseAdmin
    .from(SESSIONS_TABLE)
    .delete()
    .eq("token_hash", hashSessionToken(token));
  if (error) logError("database_delete_session_failed", { error: error.message });
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  // Opportunistic cleanup so the sessions table does not grow forever.
  await supabaseAdmin
    .from(SESSIONS_TABLE)
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString());

  const { error } = await supabaseAdmin.from(SESSIONS_TABLE).insert({
    user_id: userId,
    token_hash: hashSessionToken(token),
    expires_at: expiresAt,
  });

  if (error) {
    logError("database_create_session_failed", { userId, error: error.message });
    throw httpError(503, "Could not create a sign-in session.");
  }

  return { token, expiresAt };
}

// A session is valid only when the token exists, has not expired, and its account
// is still approved. Only approved accounts ever receive a token in the first place.
async function loadSessionIdentity(token) {
  const { data: sessionRow, error } = await supabaseAdmin
    .from(SESSIONS_TABLE)
    .select("user_id, expires_at")
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();

  if (error) {
    logError("database_verify_session_failed", { error: error.message });
    throw httpError(503, "Could not verify your session.");
  }
  if (!sessionRow) {
    throw httpError(401, "Your session is invalid or has expired. Please sign in again.");
  }
  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    await deleteSessionByToken(token);
    throw httpError(401, "Your session has expired. Please sign in again.");
  }

  const user = await loadUserById(sessionRow.user_id);
  if (!user) {
    await deleteSessionByToken(token);
    throw httpError(401, "Your account no longer exists. Please sign in again.");
  }
  if (user.status !== "approved") {
    // Revoke every session for an account that is no longer approved.
    await supabaseAdmin.from(SESSIONS_TABLE).delete().eq("user_id", user.id);
    throw httpError(403, "Your account is not approved for access.", {
      accountStatus: user.status,
    });
  }

  return { user, session: sessionRow };
}

async function authenticateHttp(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    logWarn("http_auth_missing_token", {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: requestIp(req),
    });
    return res.status(401).json({ error: "Sign in first; a session token is required." });
  }

  try {
    req.identity = await loadSessionIdentity(token);
    logDebug("http_auth_success", {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: requestIp(req),
      user: userLabel(req.identity.user),
      userId: req.identity.user.id,
    });
    return next();
  } catch (error) {
    const status = error.statusCode || 503;
    logWarn("http_auth_failed", {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: requestIp(req),
      status,
      reason: error.message || "Authentication failed.",
    });
    const body = { error: error.message || "Authentication failed." };
    if (error.accountStatus) body.status = error.accountStatus;
    return res.status(status).json(body);
  }
}

function requireApproved(req, res, next) {
  const user = req.identity && req.identity.user;
  if (!user || user.status !== "approved") {
    logWarn("http_access_denied", {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: requestIp(req),
      user: userLabel(user),
      userId: user ? user.id : undefined,
      status: user ? user.status : "anonymous",
      reason: "account_not_approved",
    });
    return res.status(403).json({
      error: "Your account has not been approved for MQTT access.",
      status: user ? user.status : "pending",
    });
  }
  return next();
}

function requireAdmin(req, res, next) {
  const user = req.identity && req.identity.user;
  if (!user || user.status !== "approved" || user.role !== "admin") {
    logWarn("http_admin_denied", {
      id: req.logId,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: requestIp(req),
      user: userLabel(user),
      userId: user ? user.id : undefined,
      role: user ? user.role : "anonymous",
    });
    return res.status(403).json({ error: "Administrator access is required." });
  }
  return next();
}

// Public health check: deliberately does not reveal credentials, topics, or user data.
app.get("/api/status", (_req, res) => {
  res.json({ server: "running", mqtt: mqttClient.connected ? "connected" : "disconnected" });
});

// ---------------------------------------------------------------
// Local account authentication (no Supabase Auth, no emails)
// ---------------------------------------------------------------

// Anyone may create an account. New accounts are always pending and never
// receive a session until an administrator approves them.
app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    logInfo("auth_register_attempt", {
      id: req.logId,
      email: email || "(empty)",
      ip: requestIp(req),
      ua: previewText(req.headers["user-agent"] || "-", 120),
    });

    if (!isValidEmail(email)) {
      logWarn("auth_register_rejected", { id: req.logId, email: email || "(empty)", ip: requestIp(req), reason: "invalid_email" });
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      logWarn("auth_register_rejected", {
        id: req.logId,
        email,
        ip: requestIp(req),
        reason: "invalid_password_length",
        passwordLength: password.length,
      });
      return res.status(400).json({
        error: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
      });
    }

    const registerKey = authKey(req, "register");
    if (isThrottled(registerKey, 20)) {
      logWarn("auth_register_throttled", { id: req.logId, email, ip: requestIp(req) });
      return res.status(429).json({
        error: "Too many accounts were created from this connection. Please try again later.",
      });
    }

    const passwordHash = await hashPassword(password);
    const { data, error } = await supabaseAdmin
      .from(USERS_TABLE)
      .insert({
        email,
        password_hash: passwordHash,
        status: "pending",
        role: "user",
      })
      .select("id, status")
      .single();

    if (error) {
      // 23505 = unique violation (the email already has an account).
      if (error.code === "23505") {
        logWarn("auth_register_rejected", { id: req.logId, email, ip: requestIp(req), reason: "email_exists" });
        return res.status(409).json({
          error: "An account already exists for that email. Try signing in instead.",
        });
      }
      logError("auth_register_failed", { id: req.logId, email, ip: requestIp(req), error: error.message });
      throw httpError(503, "Could not create the account.");
    }

    recordFailure(registerKey, 60 * 60 * 1000);
    logInfo("auth_register_created", {
      id: req.logId,
      email,
      userId: data.id,
      status: data.status,
      ip: requestIp(req),
    });

    return res.status(201).json({
      status: data.status,
      message:
        "Account created. An administrator must approve it before you can sign in. No email is sent; try signing in later to check your status.",
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    logInfo("auth_login_attempt", {
      id: req.logId,
      email: email || "(empty)",
      ip: requestIp(req),
      ua: previewText(req.headers["user-agent"] || "-", 120),
    });

    if (!isValidEmail(email) || password.length === 0) {
      logWarn("auth_login_rejected", { id: req.logId, email: email || "(empty)", ip: requestIp(req), reason: "missing_credentials" });
      return res.status(400).json({ error: "Enter your email address and password." });
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      logWarn("auth_login_rejected", { id: req.logId, email, ip: requestIp(req), reason: "password_too_long" });
      return res.status(400).json({ error: "Email or password is incorrect." });
    }

    const loginKey = authKey(req, "login", email);
    if (isThrottled(loginKey, 20)) {
      logWarn("auth_login_throttled", { id: req.logId, email, ip: requestIp(req) });
      return res.status(429).json({
        error: "Too many failed sign-in attempts. Please wait a few minutes and try again.",
      });
    }

    const { data: user, error } = await supabaseAdmin
      .from(USERS_TABLE)
      .select("id, email, password_hash, status, role")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      logError("auth_login_lookup_failed", { id: req.logId, email, ip: requestIp(req), error: error.message });
      throw httpError(503, "Could not sign in right now.");
    }

    const passwordMatches = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !passwordMatches) {
      recordFailure(loginKey, 15 * 60 * 1000);
      logWarn("auth_login_failed", { id: req.logId, email, ip: requestIp(req), reason: "invalid_credentials" });
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    clearFailures(loginKey);

    if (user.status === "pending") {
      logWarn("auth_login_blocked", { id: req.logId, email, userId: user.id, ip: requestIp(req), status: user.status });
      return res.status(403).json({
        error:
          "Your application is still pending administrator approval. You cannot sign in until it is approved. No email is sent; try signing in again later.",
        status: "pending",
      });
    }
    if (user.status !== "approved") {
      logWarn("auth_login_blocked", { id: req.logId, email, userId: user.id, ip: requestIp(req), status: user.status });
      return res.status(403).json({
        error: "Your account does not have access. Contact the administrator if you believe this is a mistake.",
        status: user.status,
      });
    }

    const session = await createSession(user.id);
    logInfo("auth_login_success", {
      id: req.logId,
      email: user.email,
      userId: user.id,
      role: user.role,
      ip: requestIp(req),
      expiresAt: session.expiresAt,
    });
    return res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: user.id, email: user.email },
      status: user.status,
      role: user.role,
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/logout", authenticateHttp, async (req, res, next) => {
  try {
    const { user } = req.identity;
    await deleteSessionByToken(getBearerToken(req));
    logInfo("auth_logout", {
      id: req.logId,
      user: userLabel(user),
      userId: user.id,
      ip: requestIp(req),
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Any signed-in, approved user can see their own account state.
app.get("/api/access/me", authenticateHttp, requireApproved, (req, res) => {
  const { user } = req.identity;
  logDebug("access_check", {
    id: req.logId,
    user: userLabel(user),
    userId: user.id,
    ip: requestIp(req),
    status: user.status,
    role: user.role,
  });
  res.json({
    user: { id: user.id, email: user.email || null },
    status: user.status,
    role: user.role,
  });
});

// Admin dashboard API: list accounts and their approval state.
app.get("/api/admin/users", authenticateHttp, requireAdmin, async (req, res, next) => {
  try {
    const requestedStatus = req.query.status;
    const allowedStatuses = new Set(["pending", "approved", "rejected"]);
    if (requestedStatus && !allowedStatuses.has(requestedStatus)) {
      logWarn("admin_users_list_rejected", {
        id: req.logId,
        admin: userLabel(req.identity.user),
        ip: requestIp(req),
        reason: "invalid_status_filter",
        filter: String(requestedStatus),
      });
      return res.status(400).json({ error: "status must be pending, approved, or rejected." });
    }

    let query = supabaseAdmin
      .from(USERS_TABLE)
      .select("id, email, status, role, created_at, reviewed_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (requestedStatus) query = query.eq("status", requestedStatus);

    const { data, error } = await query;
    if (error) {
      logError("admin_users_list_failed", {
        id: req.logId,
        admin: userLabel(req.identity.user),
        ip: requestIp(req),
        error: error.message,
      });
      throw error;
    }

    logInfo("admin_users_list", {
      id: req.logId,
      admin: userLabel(req.identity.user),
      adminId: req.identity.user.id,
      ip: requestIp(req),
      filter: requestedStatus || "all",
      count: (data || []).length,
    });

    return res.json({
      users: (data || []).map((row) => ({ ...row, user_id: row.id })),
    });
  } catch (error) {
    return next(error);
  }
});

// Admins can approve or reject users, but cannot change anyone's role through this endpoint.
app.patch(
  "/api/admin/users/:userId/approval",
  authenticateHttp,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { status } = req.body || {};
      logInfo("admin_user_approval_attempt", {
        id: req.logId,
        admin: userLabel(req.identity.user),
        adminId: req.identity.user.id,
        targetUserId: userId,
        requestedStatus: status,
        ip: requestIp(req),
      });

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        logWarn("admin_user_approval_rejected", { id: req.logId, reason: "invalid_user_id", targetUserId: userId });
        return res.status(400).json({ error: "userId must be a valid UUID." });
      }
      if (!["approved", "rejected"].includes(status)) {
        logWarn("admin_user_approval_rejected", { id: req.logId, reason: "invalid_status", targetUserId: userId, requestedStatus: status });
        return res.status(400).json({ error: "status must be approved or rejected." });
      }
      if (userId === req.identity.user.id && status !== "approved") {
        logWarn("admin_user_approval_rejected", { id: req.logId, reason: "self_revoke", targetUserId: userId });
        return res.status(400).json({ error: "You cannot revoke your own administrator account here." });
      }

      const { data, error } = await supabaseAdmin
        .from(USERS_TABLE)
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: req.identity.user.id })
        .eq("id", userId)
        .select("id, email, status, role, reviewed_at")
        .maybeSingle();

      if (error) {
        logError("admin_user_approval_failed", {
          id: req.logId,
          admin: userLabel(req.identity.user),
          targetUserId: userId,
          requestedStatus: status,
          error: error.message,
        });
        throw error;
      }
      if (!data) {
        logWarn("admin_user_approval_rejected", { id: req.logId, reason: "user_not_found", targetUserId: userId });
        return res.status(404).json({ error: "No account found for that user." });
      }

      let revokedSockets = 0;
      // A revoked user must not keep an existing session or an already-open WebSocket.
      if (status !== "approved") {
        await supabaseAdmin.from(SESSIONS_TABLE).delete().eq("user_id", userId);
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.userId === userId) {
            revokedSockets += 1;
            logInfo("socket_access_revoked", {
              socketId: socket.id,
              user: socket.data.userEmail || userLabel(data),
              userId,
              ip: socketIp(socket),
              status,
            });
            socket.emit("access-revoked", { status });
            socket.disconnect(true);
          }
        }
      }

      logInfo("admin_user_approval", {
        id: req.logId,
        admin: userLabel(req.identity.user),
        adminId: req.identity.user.id,
        targetUserId: data.id,
        targetEmail: data.email,
        status: data.status,
        revokedSockets,
        ip: requestIp(req),
      });

      return res.json({ user: { ...data, user_id: data.id } });
    } catch (error) {
      return next(error);
    }
  }
);

// Backend -> Mosquitto connection. Browser users never receive these MQTT credentials.
const mqttClient = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  reconnectPeriod: 3000,
  connectTimeout: 5000,
  clean: true,
});

// Each browser socket owns one topic filter. The backend keeps a reference
// count so the broker has one real subscription per filter, no matter how many
// listeners are tuned to it.
const topicSubscriptions = new Map();

function subscribeBrokerFilter(filter) {
  if (!mqttClient.connected) return;
  mqttClient.subscribe(filter, { qos: 0 }, (error) => {
    if (error) {
      logError("mqtt_subscribe_failed", { filter, error: error.message });
    } else {
      const subscribers = topicSubscriptions.get(filter);
      logInfo("mqtt_subscribe", {
        filter,
        listeners: subscribers ? subscribers.size : 0,
        broker: redactUrl(MQTT_URL),
      });
    }
  });
}

function unsubscribeBrokerFilter(filter) {
  if (!mqttClient.connected) return;
  mqttClient.unsubscribe(filter, (error) => {
    if (error) {
      logError("mqtt_unsubscribe_failed", { filter, error: error.message });
    } else {
      logInfo("mqtt_unsubscribe", { filter, broker: redactUrl(MQTT_URL) });
    }
  });
}

function setSocketTopic(socket, filter) {
  const previous = socket.data.topicFilter;
  if (previous === filter) return;
  if (previous) clearSocketTopic(socket);

  socket.data.topicFilter = filter;
  let subscribers = topicSubscriptions.get(filter);
  if (!subscribers) {
    subscribers = new Set();
    topicSubscriptions.set(filter, subscribers);
  }
  subscribers.add(socket);
  logInfo("socket_tune", {
    socketId: socket.id,
    user: socket.data.userEmail || "unknown",
    userId: socket.data.userId,
    ip: socketIp(socket),
    from: previous || "-",
    to: filter,
    listeners: subscribers.size,
  });
  if (subscribers.size === 1) subscribeBrokerFilter(filter);
}

function clearSocketTopic(socket) {
  const filter = socket.data.topicFilter;
  if (!filter) return;
  socket.data.topicFilter = null;

  const subscribers = topicSubscriptions.get(filter);
  if (!subscribers) {
    logWarn("socket_untune_missing_subscription", {
      socketId: socket.id,
      user: socket.data.userEmail || "unknown",
      userId: socket.data.userId,
      filter,
    });
    return;
  }
  subscribers.delete(socket);
  logInfo("socket_untune", {
    socketId: socket.id,
    user: socket.data.userEmail || "unknown",
    userId: socket.data.userId,
    ip: socketIp(socket),
    filter,
    remaining: subscribers.size,
  });
  if (subscribers.size === 0) {
    topicSubscriptions.delete(filter);
    unsubscribeBrokerFilter(filter);
  }
}

mqttClient.on("connect", () => {
  logInfo("mqtt_connected", {
    broker: redactUrl(MQTT_URL),
    restoredFilters: topicSubscriptions.size,
  });
  // clean: true means subscriptions are lost on reconnect, so restore every
  // filter that an approved browser is currently tuned to.
  for (const filter of topicSubscriptions.keys()) subscribeBrokerFilter(filter);
  io.emit("mqtt-status", "connected");
});

mqttClient.on("reconnect", () => logWarn("mqtt_reconnecting", { broker: redactUrl(MQTT_URL) }));
mqttClient.on("offline", () => logWarn("mqtt_offline", { broker: redactUrl(MQTT_URL) }));
mqttClient.on("error", (error) => {
  logError("mqtt_error", { broker: redactUrl(MQTT_URL), error: error.message });
  io.emit("mqtt-status", "disconnected");
});
mqttClient.on("close", () => {
  logWarn("mqtt_disconnected", { broker: redactUrl(MQTT_URL) });
  io.emit("mqtt-status", "disconnected");
});

// Mosquitto delivers one copy per matching subscription when the same client
// has overlapping filters (for example "home/#" and "home/test"). Keep a very
// short-lived fingerprint so each broker message is routed to the browser once.
const recentBrokerMessages = new Map();
const BROKER_DUPLICATE_WINDOW_MS = 100;
const BROKER_DUPLICATE_CACHE_LIMIT = 500;

function isDuplicateBrokerMessage(topic, message) {
  const now = Date.now();
  const key = `${topic}\u0000${message}`;
  const previous = recentBrokerMessages.get(key);
  if (previous !== undefined && now - previous < BROKER_DUPLICATE_WINDOW_MS) {
    return true;
  }

  recentBrokerMessages.set(key, now);
  if (recentBrokerMessages.size > BROKER_DUPLICATE_CACHE_LIMIT) {
    for (const [cachedKey, seenAt] of recentBrokerMessages) {
      if (now - seenAt >= BROKER_DUPLICATE_WINDOW_MS) recentBrokerMessages.delete(cachedKey);
    }
    while (recentBrokerMessages.size > BROKER_DUPLICATE_CACHE_LIMIT) {
      recentBrokerMessages.delete(recentBrokerMessages.keys().next().value);
    }
  }
  return false;
}

// Route each broker message only to sockets whose tuned filter matches it.
mqttClient.on("message", (topic, payload) => {
  const message = payload.toString();
  const messageBytes = Buffer.byteLength(message);
  if (topicSubscriptions.size === 0) {
    logDebug("mqtt_message_no_listeners", {
      topic,
      bytes: messageBytes,
      preview: previewText(message, 160),
    });
    return;
  }
  if (isDuplicateBrokerMessage(topic, message)) {
    logDebug("mqtt_message_duplicate", {
      topic,
      bytes: messageBytes,
      preview: previewText(message, 160),
    });
    return;
  }
  const entry = {
    topic,
    message,
    receivedAt: new Date().toISOString(),
  };

  const matchedFilters = [];
  let recipients = 0;
  for (const [filter, subscribers] of topicSubscriptions) {
    if (!topicMatchesFilter(filter, topic)) continue;
    matchedFilters.push(filter);
    for (const socket of subscribers) {
      socket.emit("mqtt-message", entry);
      recipients += 1;
    }
  }

  logInfo("mqtt_message", {
    topic,
    bytes: messageBytes,
    preview: previewText(message, 160),
    matchedFilters: matchedFilters.length,
    filters: matchedFilters.join(","),
    recipients,
  });
});

io.use(async (socket, next) => {
  const token =
    (socket.handshake.auth && (socket.handshake.auth.token || socket.handshake.auth.accessToken)) || "";
  const authDetails = {
    socketId: socket.id,
    ip: socketIp(socket),
    origin: socket.handshake.headers.origin || "-",
    transport: socket.conn && socket.conn.transport ? socket.conn.transport.name : "unknown",
  };

  if (typeof token !== "string" || token.length < 20) {
    logWarn("socket_auth_rejected", { ...authDetails, reason: "missing_session_token" });
    return next(new Error("A sign-in session is required."));
  }

  try {
    const { user } = await loadSessionIdentity(token);
    socket.data.userId = user.id;
    socket.data.userEmail = user.email || null;
    socket.data.role = user.role;
    logDebug("socket_auth_success", {
      ...authDetails,
      user: userLabel(user),
      userId: user.id,
      role: user.role,
    });
    return next();
  } catch (error) {
    logWarn("socket_auth_rejected", {
      ...authDetails,
      status: error.statusCode || 503,
      reason: error.message || "Could not authorize connection.",
    });
    if (error.statusCode === 401) {
      return next(new Error("Your session is invalid or expired. Please sign in again."));
    }
    if (error.statusCode === 403) {
      return next(new Error(error.message));
    }
    return next(new Error("Could not authorize connection."));
  }
});

io.on("connection", (socket) => {
  logInfo("socket_connect", {
    socketId: socket.id,
    user: socket.data.userEmail || "unknown",
    userId: socket.data.userId,
    role: socket.data.role,
    ip: socketIp(socket),
    origin: socket.handshake.headers.origin || "-",
    transport: socket.conn && socket.conn.transport ? socket.conn.transport.name : "unknown",
    ua: previewText(socket.handshake.headers["user-agent"] || "-", 120),
  });

  socket.emit("mqtt-status", mqttClient.connected ? "connected" : "disconnected");

  // Every new listener starts on the "scan all" station.
  setSocketTopic(socket, DEFAULT_TOPIC_FILTER);
  socket.emit("tuned", { topic: DEFAULT_TOPIC_FILTER });

  socket.on("tune", (data, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    if (!data || typeof data.topic !== "string") {
      logWarn("socket_tune_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "invalid_data",
      });
      return reply({ ok: false, error: "Choose a topic filter first." });
    }

    const filter = data.topic.trim();
    if (!isValidTopicFilter(filter)) {
      logWarn("socket_tune_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "invalid_filter",
        filter,
      });
      return reply({
        ok: false,
        error: "Use a topic filter such as home/kitchen/#, home/+/status, or home/test.",
      });
    }

    setSocketTopic(socket, filter);
    socket.emit("tuned", { topic: filter });
    return reply({ ok: true, topic: filter });
  });

  socket.on("disconnect", (reason) => {
    logInfo("socket_disconnect", {
      socketId: socket.id,
      user: socket.data.userEmail || "unknown",
      userId: socket.data.userId,
      ip: socketIp(socket),
      reason: reason || "unknown",
    });
    clearSocketTopic(socket);
  });

  socket.on("publish-message", (data, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};

    if (!data || typeof data.topic !== "string" || typeof data.message !== "string") {
      logWarn("socket_publish_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "invalid_data",
      });
      return reply({ ok: false, error: "Invalid message data." });
    }

    const topic = data.topic.trim();
    const message = data.message;
    if (
      !/^home\/[A-Za-z0-9_/-]+$/.test(topic) ||
      topic.includes("//") ||
      topic.endsWith("/") ||
      topic.length > 128
    ) {
      logWarn("socket_publish_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "invalid_topic",
        topic,
      });
      return reply({ ok: false, error: "Use a valid topic such as home/test." });
    }
    if (message.length < 1 || message.length > 1000) {
      logWarn("socket_publish_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "invalid_message_length",
        topic,
        length: message.length,
      });
      return reply({ ok: false, error: "Message must contain 1–1000 characters." });
    }
    if (!mqttClient.connected) {
      logWarn("socket_publish_rejected", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        ip: socketIp(socket),
        reason: "mqtt_not_connected",
        topic,
      });
      return reply({ ok: false, error: "MQTT broker is not connected." });
    }

    logInfo("socket_publish", {
      socketId: socket.id,
      user: socket.data.userEmail || "unknown",
      userId: socket.data.userId,
      ip: socketIp(socket),
      topic,
      bytes: Buffer.byteLength(message),
      preview: previewText(message, 160),
    });

    mqttClient.publish(topic, message, { qos: 0, retain: false }, (error) => {
      if (error) {
        logError("mqtt_publish_failed", {
          socketId: socket.id,
          user: socket.data.userEmail || "unknown",
          userId: socket.data.userId,
          topic,
          bytes: Buffer.byteLength(message),
          error: error.message,
        });
        return reply({ ok: false, error: "Publishing failed." });
      }
      logInfo("mqtt_publish", {
        socketId: socket.id,
        user: socket.data.userEmail || "unknown",
        userId: socket.data.userId,
        topic,
        bytes: Buffer.byteLength(message),
      });
      // This confirms MQTT accepted the publish; it does not prove a device acted on it.
      return reply({ ok: true });
    });
  });
});

app.use((error, req, res, _next) => {
  const status = error.statusCode || 500;
  const details = {
    id: req.logId,
    method: req.method,
    path: req.originalUrl || req.url,
    status,
    ip: requestIp(req),
    user: req.identity ? userLabel(req.identity.user) : "anonymous",
    userId: req.identity ? req.identity.user.id : undefined,
    error: error.message || "Unknown error",
  };

  if (status >= 500) {
    logError("http_error", { ...details, stack: error.stack });
  } else {
    logWarn("http_error", details);
  }

  if (res.headersSent) return _next(error);
  if (error.statusCode) {
    return res.status(status).json({ error: error.message });
  }
  return res.status(500).json({ error: "Internal server error." });
});

server.on("error", (error) => {
  logError("server_error", { error: error.message, code: error.code });
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  logInfo("server_started", {
    url: `http://${HOST}:${PORT}`,
    node: process.version,
    pid: process.pid,
    publicDir: PUBLIC_DIR,
    usersTable: USERS_TABLE,
    sessionsTable: SESSIONS_TABLE,
    mqttBroker: redactUrl(MQTT_URL),
    cors: allowAllOrigins ? "*" : allowedOrigins.length,
    logLevel: LOG_LEVEL_NAME,
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("server_shutdown", { signal });
  io.close();
  mqttClient.end(false, {}, () => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
