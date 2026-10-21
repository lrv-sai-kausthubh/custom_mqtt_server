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

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");

const app = express();
const server = http.createServer(app);
// The Cloudflare Tunnel connects from loopback, so its forwarded client IP is trusted.
app.set("trust proxy", "loopback");
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
    console.error("Failed to read account:", error.message);
    throw httpError(503, "Could not read the account record.");
  }
  return data || null;
}

async function deleteSessionByToken(token) {
  const { error } = await supabaseAdmin
    .from(SESSIONS_TABLE)
    .delete()
    .eq("token_hash", hashSessionToken(token));
  if (error) console.error("Failed to delete session:", error.message);
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
    console.error("Failed to create session:", error.message);
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
    console.error("Failed to verify session:", error.message);
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
    return res.status(401).json({ error: "Sign in first; a session token is required." });
  }

  try {
    req.identity = await loadSessionIdentity(token);
    return next();
  } catch (error) {
    const body = { error: error.message || "Authentication failed." };
    if (error.accountStatus) body.status = error.accountStatus;
    return res.status(error.statusCode || 503).json(body);
  }
}

function requireApproved(req, res, next) {
  const user = req.identity && req.identity.user;
  if (!user || user.status !== "approved") {
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

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      return res.status(400).json({
        error: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
      });
    }

    const registerKey = authKey(req, "register");
    if (isThrottled(registerKey, 20)) {
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
        return res.status(409).json({
          error: "An account already exists for that email. Try signing in instead.",
        });
      }
      console.error("Failed to register account:", error.message);
      throw httpError(503, "Could not create the account.");
    }

    recordFailure(registerKey, 60 * 60 * 1000);

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

    if (!isValidEmail(email) || password.length === 0) {
      return res.status(400).json({ error: "Enter your email address and password." });
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      return res.status(400).json({ error: "Email or password is incorrect." });
    }

    const loginKey = authKey(req, "login", email);
    if (isThrottled(loginKey, 20)) {
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
      console.error("Failed to read account during sign-in:", error.message);
      throw httpError(503, "Could not sign in right now.");
    }

    const passwordMatches = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !passwordMatches) {
      recordFailure(loginKey, 15 * 60 * 1000);
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    clearFailures(loginKey);

    if (user.status === "pending") {
      return res.status(403).json({
        error:
          "Your application is still pending administrator approval. You cannot sign in until it is approved. No email is sent; try signing in again later.",
        status: "pending",
      });
    }
    if (user.status !== "approved") {
      return res.status(403).json({
        error: "Your account does not have access. Contact the administrator if you believe this is a mistake.",
        status: user.status,
      });
    }

    const session = await createSession(user.id);
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
    await deleteSessionByToken(getBearerToken(req));
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Any signed-in, approved user can see their own account state.
app.get("/api/access/me", authenticateHttp, requireApproved, (req, res) => {
  const { user } = req.identity;
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
      return res.status(400).json({ error: "status must be pending, approved, or rejected." });
    }

    let query = supabaseAdmin
      .from(USERS_TABLE)
      .select("id, email, status, role, created_at, reviewed_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (requestedStatus) query = query.eq("status", requestedStatus);

    const { data, error } = await query;
    if (error) throw error;

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
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        return res.status(400).json({ error: "userId must be a valid UUID." });
      }
      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "status must be approved or rejected." });
      }
      if (userId === req.identity.user.id && status !== "approved") {
        return res.status(400).json({ error: "You cannot revoke your own administrator account here." });
      }

      const { data, error } = await supabaseAdmin
        .from(USERS_TABLE)
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: req.identity.user.id })
        .eq("id", userId)
        .select("id, email, status, role, reviewed_at")
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: "No account found for that user." });

      // A revoked user must not keep an existing session or an already-open WebSocket.
      if (status !== "approved") {
        await supabaseAdmin.from(SESSIONS_TABLE).delete().eq("user_id", userId);
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.userId === userId) {
            socket.emit("access-revoked", { status });
            socket.disconnect(true);
          }
        }
      }
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
    if (error) console.error(`MQTT subscribe failed for ${filter}:`, error.message);
    else console.log(`Subscribed to ${filter}.`);
  });
}

function unsubscribeBrokerFilter(filter) {
  if (!mqttClient.connected) return;
  mqttClient.unsubscribe(filter, (error) => {
    if (error) console.error(`MQTT unsubscribe failed for ${filter}:`, error.message);
    else console.log(`Unsubscribed from ${filter}.`);
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
  if (subscribers.size === 1) subscribeBrokerFilter(filter);
}

function clearSocketTopic(socket) {
  const filter = socket.data.topicFilter;
  if (!filter) return;
  socket.data.topicFilter = null;

  const subscribers = topicSubscriptions.get(filter);
  if (!subscribers) return;
  subscribers.delete(socket);
  if (subscribers.size === 0) {
    topicSubscriptions.delete(filter);
    unsubscribeBrokerFilter(filter);
  }
}

mqttClient.on("connect", () => {
  console.log("Connected to Mosquitto.");
  // clean: true means subscriptions are lost on reconnect, so restore every
  // filter that an approved browser is currently tuned to.
  for (const filter of topicSubscriptions.keys()) subscribeBrokerFilter(filter);
  io.emit("mqtt-status", "connected");
});

mqttClient.on("reconnect", () => console.log("Reconnecting to Mosquitto..."));
mqttClient.on("error", (error) => {
  console.error("MQTT error:", error.message);
  io.emit("mqtt-status", "disconnected");
});
mqttClient.on("close", () => io.emit("mqtt-status", "disconnected"));

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
  if (topicSubscriptions.size === 0) return;
  const message = payload.toString();
  if (isDuplicateBrokerMessage(topic, message)) return;
  const entry = {
    topic,
    message,
    receivedAt: new Date().toISOString(),
  };

  for (const [filter, subscribers] of topicSubscriptions) {
    if (!topicMatchesFilter(filter, topic)) continue;
    for (const socket of subscribers) socket.emit("mqtt-message", entry);
  }
});

io.use(async (socket, next) => {
  const token =
    (socket.handshake.auth && (socket.handshake.auth.token || socket.handshake.auth.accessToken)) || "";
  if (typeof token !== "string" || token.length < 20) {
    return next(new Error("A sign-in session is required."));
  }

  try {
    const { user } = await loadSessionIdentity(token);
    socket.data.userId = user.id;
    socket.data.role = user.role;
    return next();
  } catch (error) {
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
  socket.emit("mqtt-status", mqttClient.connected ? "connected" : "disconnected");

  // Every new listener starts on the "scan all" station.
  setSocketTopic(socket, DEFAULT_TOPIC_FILTER);
  socket.emit("tuned", { topic: DEFAULT_TOPIC_FILTER });

  socket.on("tune", (data, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    if (!data || typeof data.topic !== "string") {
      return reply({ ok: false, error: "Choose a topic filter first." });
    }

    const filter = data.topic.trim();
    if (!isValidTopicFilter(filter)) {
      return reply({
        ok: false,
        error: "Use a topic filter such as home/kitchen/#, home/+/status, or home/test.",
      });
    }

    setSocketTopic(socket, filter);
    socket.emit("tuned", { topic: filter });
    return reply({ ok: true, topic: filter });
  });

  socket.on("disconnect", () => clearSocketTopic(socket));

  socket.on("publish-message", (data, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};

    if (!data || typeof data.topic !== "string" || typeof data.message !== "string") {
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
      return reply({ ok: false, error: "Use a valid topic such as home/test." });
    }
    if (message.length < 1 || message.length > 1000) {
      return reply({ ok: false, error: "Message must contain 1–1000 characters." });
    }
    if (!mqttClient.connected) {
      return reply({ ok: false, error: "MQTT broker is not connected." });
    }

    mqttClient.publish(topic, message, { qos: 0, retain: false }, (error) => {
      if (error) return reply({ ok: false, error: "Publishing failed." });
      // This confirms MQTT accepted the publish; it does not prove a device acted on it.
      return reply({ ok: true });
    });
  });
});

app.use((error, _req, res, _next) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error("Unhandled API error:", error.message);
  return res.status(500).json({ error: "Internal server error." });
});

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on http://${HOST}:${PORT}`);
  console.log(`Static frontend directory: ${PUBLIC_DIR}`);
  if (allowAllOrigins) console.log("CORS is open to all origins (ALLOWED_ORIGINS=*).");
  else if (allowedOrigins.length) console.log(`CORS allowlist configured for ${allowedOrigins.length} origin(s).`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down...`);
  io.close();
  mqttClient.end(false, {}, () => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
