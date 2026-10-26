const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const DEVICE_WS_PATH = process.env.DEVICE_WS_PATH || "/device";
const DEVICE_WS_TOKEN = process.env.DEVICE_WS_TOKEN;
const MQTT_INGEST_SECRET = process.env.MQTT_INGEST_SECRET;
const DEVICE_HEARTBEAT_MS = Math.max(Number(process.env.DEVICE_HEARTBEAT_MS) || 15000, 5000);

function validBoardId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function previewBytes(buffer, maxLength = 64) {
  const bytes = Buffer.from(buffer).subarray(0, maxLength);
  const hex = bytes.toString("hex");
  const text = bytes.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  return { hex, text };
}

function validRelayIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= 31;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(req) {
  if (!MQTT_INGEST_SECRET) return false;
  const timestamp = String(req.headers["x-mqtt-timestamp"] || "");
  const timestampMs = Number(timestamp) * 1000;
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 120000) {
    return false;
  }

  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody.toString("utf8")
    : JSON.stringify(req.body || {});
  const expected = crypto
    .createHmac("sha256", MQTT_INGEST_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return safeEqual(expected, req.headers["x-mqtt-signature"]);
}

function commandTopic(boardId, relayIndex) {
  return `home/${boardId}/device/${relayIndex}/set`;
}

function attachDeviceGateway({ app, server, mqttClient, logInfo, logWarn, logError }) {
  if (!DEVICE_WS_TOKEN || !MQTT_INGEST_SECRET) {
    throw new Error("DEVICE_WS_TOKEN and MQTT_INGEST_SECRET must be configured");
  }

  const socketsByBoard = new Map();
  const filtersByBoard = new Map();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 8192 });

  // Mosquitto sends one copy per matching subscription. A browser tuned to
  // home/# plus the board filter home/<board>/device/+/set would otherwise
  // deliver the same relay command to the ESP32 twice. Keep a very short-lived
  // fingerprint so each broker command is forwarded once.
  const recentDeviceMessages = new Map();
  const DEVICE_DUPLICATE_WINDOW_MS = 250;
  const DEVICE_DUPLICATE_CACHE_LIMIT = 200;

  function isDuplicateDeviceMessage(topic, payload) {
    const key = `${topic}\u0000${payload}`;
    const now = Date.now();
    const previous = recentDeviceMessages.get(key);
    if (previous !== undefined && now - previous < DEVICE_DUPLICATE_WINDOW_MS) {
      return true;
    }

    recentDeviceMessages.set(key, now);
    if (recentDeviceMessages.size > DEVICE_DUPLICATE_CACHE_LIMIT) {
      for (const [cachedKey, seenAt] of recentDeviceMessages) {
        if (now - seenAt >= DEVICE_DUPLICATE_WINDOW_MS) recentDeviceMessages.delete(cachedKey);
      }
      while (recentDeviceMessages.size > DEVICE_DUPLICATE_CACHE_LIMIT) {
        recentDeviceMessages.delete(recentDeviceMessages.keys().next().value);
      }
    }
    return false;
  }

  function socketSet(boardId) {
    let sockets = socketsByBoard.get(boardId);
    if (!sockets) {
      sockets = new Set();
      socketsByBoard.set(boardId, sockets);
    }
    return sockets;
  }

  function broadcast(boardId, message) {
    const sockets = socketsByBoard.get(boardId);
    if (!sockets) return;
    const encoded = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(encoded);
    }
  }

  function broadcastHealth() {
    const message = {
      type: "heartbeat",
      mqtt: mqttClient.connected ? "connected" : "disconnected",
      ts: new Date().toISOString(),
    };
    for (const boardId of socketsByBoard.keys()) broadcast(boardId, message);
  }

  function subscribeBoard(boardId) {
    const filter = filtersByBoard.get(boardId) || `home/${boardId}/device/+/set`;
    filtersByBoard.set(boardId, filter);
    if (!mqttClient.connected) return;
    mqttClient.subscribe(filter, { qos: 1 }, (error) => {
      if (error) logError("device_mqtt_subscribe_failed", { boardId, filter, error: error.message });
      else logInfo("device_mqtt_subscribed", { boardId, filter });
    });
  }

  function unsubscribeBoard(boardId) {
    const filter = filtersByBoard.get(boardId);
    if (!filter) return;
    filtersByBoard.delete(boardId);
    if (!mqttClient.connected) return;
    mqttClient.unsubscribe(filter, (error) => {
      if (error) logError("device_mqtt_unsubscribe_failed", { boardId, filter, error: error.message });
    });
  }

  app.post("/api/device/command", (req, res) => {
    if (!verifySignature(req)) {
      logWarn("device_command_rejected", { reason: "invalid_signature", ip: req.ip });
      return res.status(401).json({ error: "Invalid command signature." });
    }

    const body = req.body || {};
    const boardId = body.board_identifier;
    const relayIndex = body.relay_index;
    if (!validBoardId(boardId) || !validRelayIndex(relayIndex) || typeof body.state !== "boolean") {
      return res.status(400).json({ error: "Invalid board_identifier, relay_index, or state." });
    }
    if (body.command_id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(String(body.command_id))) {
      return res.status(400).json({ error: "Invalid command_id." });
    }

    if (!mqttClient.connected) {
      logWarn("device_command_deferred", { boardId, relayIndex, reason: "mqtt_disconnected" });
      return res.status(503).json({ error: "MQTT broker is not connected." });
    }

    const payload = JSON.stringify({
      v: 1,
      command_id: String(body.command_id || crypto.randomUUID()),
      state: body.state,
      last_changed: body.last_changed || null,
      issued_at: new Date().toISOString(),
    });
    const topic = commandTopic(boardId, relayIndex);

    mqttClient.publish(topic, payload, { qos: 1, retain: true }, (error) => {
      if (error) {
        logError("device_command_publish_failed", { boardId, relayIndex, topic, error: error.message });
        return res.status(502).json({ error: "Could not publish the device command." });
      }
      logInfo("device_command_published", { boardId, relayIndex, topic, bytes: Buffer.byteLength(payload) });
      return res.status(202).json({ ok: true, topic });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch (_error) {
      socket.destroy();
      return;
    }
    if (url.pathname !== DEVICE_WS_PATH) return;

    const boardId = url.searchParams.get("board");
    const suppliedToken = String(request.headers["x-device-token"] || url.searchParams.get("token") || "");
    if (!validBoardId(boardId) || !safeEqual(suppliedToken, DEVICE_WS_TOKEN)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Keep the first bytes the client sends. If `ws` rejects the frame, the
    // error handler logs this preview so the firmware protocol can be
    // identified (JSON text vs MQTT bytes vs a broken WebSocket library).
    const framePreview = {
      value: head && head.length > 0 ? Buffer.from(head).subarray(0, 64) : null,
    };
    if (!framePreview.value) {
      socket.once("data", (chunk) => {
        framePreview.value = Buffer.from(chunk).subarray(0, 64);
      });
    }

    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      ws.framePreview = framePreview;
      websocketServer.emit("connection", ws, request, boardId);
    });
  });

  websocketServer.on("connection", (ws, request, boardId) => {
    const sockets = socketSet(boardId);
    sockets.add(ws);
    subscribeBoard(boardId);

    logInfo("device_ws_connected", {
      boardId,
      ip: request.headers["cf-connecting-ip"] || request.socket.remoteAddress || "unknown",
      mqtt: mqttClient.connected ? "connected" : "disconnected",
    });

    ws.send(JSON.stringify({
      type: "hello",
      board: boardId,
      mqtt: mqttClient.connected ? "connected" : "disconnected",
      ts: new Date().toISOString(),
    }));

    ws.on("message", (data) => {
      // The ESP32 only needs downlink commands. Accepting no arbitrary publish
      // operation keeps the public tunnel from becoming an MQTT write proxy.
      try {
        const message = JSON.parse(data.toString());
        if (message && message.type === "pong") ws.lastPongAt = Date.now();
      } catch (_error) {
        logWarn("device_ws_invalid_message", { boardId });
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      if (sockets.size === 0) {
        socketsByBoard.delete(boardId);
        unsubscribeBoard(boardId);
      }
      logInfo("device_ws_disconnected", { boardId });
    });

    ws.on("error", (error) => {
      const preview = ws.framePreview && ws.framePreview.value;
      if (preview) {
        const { hex, text } = previewBytes(preview);
        logWarn("device_ws_bad_frame", { boardId, error: error.message, hex, text });
      }
      logWarn("device_ws_error", { boardId, error: error.message });
    });
  });

  mqttClient.on("connect", () => {
    for (const boardId of filtersByBoard.keys()) subscribeBoard(boardId);
    broadcastHealth();
  });
  mqttClient.on("close", broadcastHealth);
  mqttClient.on("error", broadcastHealth);
  mqttClient.on("message", (topic, payload) => {
    const match = /^home\/([A-Za-z0-9_-]{1,64})\/device\/([0-9]+)\/set$/.exec(topic);
    if (!match) return;
    const payloadText = payload.toString();
    if (isDuplicateDeviceMessage(topic, payloadText)) return;
    const boardId = match[1];
    broadcast(boardId, {
      type: "mqtt",
      topic,
      payload: payloadText,
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const [boardId, sockets] of socketsByBoard) {
      for (const ws of sockets) {
        if (ws.readyState !== 1) continue;
        ws.send(JSON.stringify({
          type: "heartbeat",
          mqtt: mqttClient.connected ? "connected" : "disconnected",
          ts: new Date().toISOString(),
        }));
      }
      if (sockets.size === 0) socketsByBoard.delete(boardId);
    }
  }, DEVICE_HEARTBEAT_MS);
  heartbeatTimer.unref();

  return {
    close() {
      clearInterval(heartbeatTimer);
      for (const sockets of socketsByBoard.values()) {
        for (const ws of sockets) ws.close(1001, "Server shutting down");
      }
      websocketServer.close();
    },
  };
}

module.exports = { attachDeviceGateway };
