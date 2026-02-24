"use strict";

const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const DEFAULT_WS_PATH = "/ws";

function getClientIp(request) {
  const forwardedFor = request?.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request?.socket?.remoteAddress || "unknown";
}

function getMessageBytes(data) {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  return 0;
}

function getMessageText(data, isBinary) {
  if (isBinary) {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8"
    );
  }
  return null;
}

function tryParseJson(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function addDdpTags(span, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (payload.msg) {
    span.setTag("ddp.msg", String(payload.msg));
  }
  if (payload.id) {
    span.setTag("ddp.id", String(payload.id));
  }
  if (payload.method) {
    span.setTag("ddp.method", String(payload.method));
  }
  if (payload.name) {
    span.setTag("ddp.sub", String(payload.name));
  }
  if (payload.collection) {
    span.setTag("ddp.collection", String(payload.collection));
  }
}

function buildResponse(payload, connectionId) {
  const now = new Date().toISOString();
  if (!payload || typeof payload !== "object") {
    return JSON.stringify({ type: "echo", receivedAt: now });
  }

  switch (payload.msg) {
    case "connect":
      return JSON.stringify({ msg: "connected", session: connectionId });
    case "ping":
      return JSON.stringify({ msg: "pong", id: payload.id });
    case "sub":
      return JSON.stringify({ msg: "ready", subs: payload.id ? [payload.id] : [] });
    case "method":
      return JSON.stringify({ msg: "result", id: payload.id, result: "ok" });
    default:
      return JSON.stringify({ type: "echo", receivedAt: now, ddp: payload.msg });
  }
}

function initWebsocketServer({
  server,
  tracer,
  path = DEFAULT_WS_PATH,
  serviceName = process.env.DD_SERVICE || "three-tier-backend",
} = {}) {
  if (!server) {
    throw new Error("WebSocket server requires an HTTP server instance.");
  }
  if (!tracer) {
    throw new Error("WebSocket server requires a Datadog tracer instance.");
  }

  const wss = new WebSocketServer({ server, path });

  wss.on("connection", (socket, request) => {
    const connectionId = crypto.randomUUID();
    const clientIp = getClientIp(request);
    const userAgent = request?.headers?.["user-agent"] || "unknown";
    const origin = request?.headers?.origin || "unknown";

    const connectionSpan = tracer.startSpan("ws.connection", {
      service: serviceName,
      resource: path,
      tags: {
        "ws.connection_id": connectionId,
        "ws.client_ip": clientIp,
        "ws.path": path,
        "ws.user_agent": userAgent,
        "ws.origin": origin,
      },
    });

    socket.on("message", (data, isBinary) => {
      const bytes = getMessageBytes(data);
      const messageText = getMessageText(data, isBinary);
      const payload = tryParseJson(messageText);

      const messageSpan = tracer.startSpan("ws.message", {
        service: serviceName,
        resource: payload?.msg || (isBinary ? "binary" : "text"),
        childOf: connectionSpan,
        tags: {
          "ws.connection_id": connectionId,
          "ws.message.bytes": bytes,
          "ws.message.binary": Boolean(isBinary),
        },
      });

      if (payload) {
        addDdpTags(messageSpan, payload);
      }
      messageSpan.finish();

      if (socket.readyState === socket.OPEN) {
        const response = buildResponse(payload, connectionId);
        const responseBytes = Buffer.byteLength(response);
        const sendSpan = tracer.startSpan("ws.send", {
          service: serviceName,
          resource: payload?.msg || "echo",
          childOf: connectionSpan,
          tags: {
            "ws.connection_id": connectionId,
            "ws.message.bytes": responseBytes,
          },
        });

        socket.send(response, (error) => {
          if (error) {
            sendSpan.setTag("error", error);
          }
          sendSpan.finish();
        });
      }
    });

    socket.on("close", (code, reason) => {
      connectionSpan.setTag("ws.close_code", code);
      if (reason && reason.length > 0) {
        connectionSpan.setTag("ws.close_reason", reason.toString());
      }
      connectionSpan.finish();
    });

    socket.on("error", (error) => {
      connectionSpan.setTag("error", error);
    });
  });

  return wss;
}

module.exports = { initWebsocketServer };
