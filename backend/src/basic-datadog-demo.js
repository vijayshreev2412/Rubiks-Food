"use strict";

// Datadog tracer must be initialized before loading instrumented libraries.
const tracer = require("dd-trace").init({
  service: process.env.DD_SERVICE || "node-dd-basic-demo",
  env: process.env.DD_ENV || "local",
  version: process.env.DD_VERSION || "1.0.0",
  logInjection: process.env.DD_LOGS_INJECTION === "true",
});

const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/work", async (req, res) => {
  try {
    const result = await tracer.trace(
      "custom.operation",
      {
        resource: "GET /work",
        tags: {
          key: "value",
          "custom.route": "/work",
        },
      },
      async (span) => {
        span.setTag("custom.user_id", req.query.userId || "anonymous");
        await sleep(100);
        return { processed: true, ts: new Date().toISOString() };
      }
    );

    res.json(result);
  } catch (error) {
    console.error("[GET /work] failed", error);
    res.status(500).json({ error: "work failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Datadog basic demo listening on http://localhost:${PORT}`);
  console.log(`Try: curl "http://localhost:${PORT}/work?userId=42"`);
});
