"use strict";

// Initialize Datadog APM before any other module loads.
const tracer = require("dd-trace").init({
  service: process.env.DD_SERVICE || "three-tier-backend",
  env: process.env.DD_ENV || process.env.NODE_ENV || "production",
  version: process.env.DD_VERSION || "1.0.0",
  logInjection: process.env.DD_LOGS_INJECTION === "true",
});

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const db = require("./db");
const {
  initRabbitmq,
  publishTaskEvent,
  consumeTaskEvents,
  closeRabbitmq,
} = require("./rabbitmq");

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/tasks", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, title, description, status, created_at FROM tasks ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("[GET /api/tasks] error", error);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

app.post("/api/tasks", async (req, res) => {
  const { title, description } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const result = await db.query(
      "INSERT INTO tasks (title, description) VALUES ($1, $2) RETURNING id, title, description, status, created_at",
      [title, description || null]
    );
    const task = result.rows[0];

    await publishTaskEvent({
      type: "TASK_CREATED",
      payload: task,
    });

    res.status(201).json(task);
  } catch (error) {
    console.error("[POST /api/tasks] error", error);
    res.status(500).json({ error: "Failed to create task" });
  }
});

app.patch("/api/tasks/:id/status", async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  try {
    const result = await db.query(
      "UPDATE tasks SET status = $1 WHERE id = $2 RETURNING id, title, description, status, created_at",
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Task not found" });
    }

    const task = result.rows[0];
    await publishTaskEvent({
      type: "TASK_STATUS_CHANGED",
      payload: task,
    });

    res.json(task);
  } catch (error) {
    console.error("[PATCH /api/tasks/:id/status] error", error);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// The consumer in rabbitmq.js creates the worker span with proper
// context propagation (inject/extract) and activates it before
// calling this handler. Any auto-instrumented call (pg, http)
// made here is automatically parented to that span.
async function handleTaskEvent(event) {
  const span = tracer.scope().active();

  switch (event?.type) {
    case "TASK_CREATED":
      await db.query("UPDATE tasks SET status = $1 WHERE id = $2", [
        "queued",
        event.payload.id,
      ]);
      if (span) span.setTag("task.status", "queued");
      console.log("[queue] Task queued", event.payload.id);
      break;
    case "TASK_STATUS_CHANGED":
      if (span) span.setTag("task.status", event.payload.status);
      console.log(
        "[queue] Status change propagated",
        event.payload.id,
        "->",
        event.payload.status
      );
      break;
    default:
      console.log("[queue] Unhandled event type", event?.type);
      if (span) span.setTag("queue.unhandled_event", true);
  }
}

async function start() {
  try {
    await db.init();
    await initRabbitmq();
    await consumeTaskEvents(handleTaskEvent);

    const server = app.listen(PORT, () => {
      console.log(`Backend listening on port ${PORT}`);
    });

    const shutdown = async () => {
      console.log("Shutting down gracefully...");
      server.close();
      await closeRabbitmq();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("Failed to start backend", error);
    process.exit(1);
  }
}

start();
