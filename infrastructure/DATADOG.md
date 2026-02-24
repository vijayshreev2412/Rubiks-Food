## Datadog APM Integration

This guide layers Datadog tracing on top of the existing Docker Compose stack. It covers instrumentation, agent deployment, and verification using the Datadog UI.

### Prerequisites

1. Datadog account with an API key that has APM access.
2. Your preferred Datadog site (`datadoghq.com`, `datadoghq.eu`, etc.).
3. The repository changes in this branch (dd-trace dependency + code hooks) pulled onto the EC2 instance.

### 1. Prepare Datadog environment variables

```bash
cd /opt/three-tier-app               # repo root on EC2
cp .env.datadog.example datadog.env  # never commit the real keys
```

Edit `datadog.env` and set the values from your Datadog account:

```
DD_API_KEY=<your_api_key>
DD_SITE=datadoghq.com                # or datadoghq.eu, us3.datadoghq.com, etc.
DD_ENV=production                    # surfaced in Datadog dashboards
DD_SERVICE=three-tier-backend        # override per deployment if needed
DD_VERSION=1.0.0
DD_LOGS_INJECTION=true
```

> Tip: keep `datadog.env` outside version control (already in `.gitignore`).

### 2. Start the stack with the Datadog override

The override file adds the Datadog Agent container and points the backend at it.

```bash
docker compose --env-file datadog.env \
  -f docker-compose.yml \
  -f docker-compose.datadog.yml \
  up -d --build
```

What happens:

- `datadog` service runs the official Agent with APM, logs, processes, and DogStatsD enabled.
- The backend container receives `DD_*` settings, auto-instruments Express/Postgres/RabbitMQ via `dd-trace`, and emits a manual span for the worker loop.
- Port `8126` is published so that other hosts (or the EC2 instance itself) can forward traces if needed.

### 3. Validate in the Datadog UI

1. Generate some traffic (create tasks, update statuses, leave the worker running).
2. Open **APM → Services** and look for `three-tier-backend`.
3. Drill down into traces to see Express endpoints, queries, and the `worker.handle_task_event` custom span.
4. Enable Log Explorer or Dashboards if you turned on log injection (`DD_LOGS_INJECTION=true`).

### 4. Production tips

- **API key rotation**: store `DD_API_KEY` in AWS Systems Manager Parameter Store or AWS Secrets Manager and inject it at deploy time.
- **Host-based agent**: if you prefer the deb/rpm agent instead of the container, install it on the EC2 host and set `DD_AGENT_HOST=host.docker.internal` (or the host IP) for the backend service.
- **Sampling**: adjust `DD_TRACE_SAMPLE_RATE` or `DD_TRACE_RATE_LIMIT` environment variables if you need to control ingestion volume.
- **Dashboards**: import Datadog’s “Node.js APM Overview” dashboard for instant visualizations.

With these steps, every deployment launched via Docker Compose gains full trace visibility in Datadog without changing the way you start the stack.

---

## Custom Spans for Asynchronous Traces

This section explains how to create custom spans that correctly track asynchronous work across your Node.js application using `dd-trace`. It covers every major pattern: simple async/await spans, scope activation, parent-child relationships, and context propagation across message queues.

All examples below assume the tracer has been initialised at the top of your entry point:

```javascript
const tracer = require("dd-trace").init({
  service: "three-tier-backend",
});
```

### 1 — `tracer.trace()`: the high-level helper

`tracer.trace(name, [options], fn)` creates a span, activates it for the duration of `fn`, and finishes it automatically. If `fn` returns a `Promise`, the span stays open until the promise settles, and errors are recorded for you.

```javascript
app.get("/api/tasks/:id", async (req, res) => {
  await tracer.trace("tasks.fetch_single", { resource: "GET /api/tasks/:id" }, async (span) => {
    span.setTag("task.id", req.params.id);

    const result = await db.query("SELECT * FROM tasks WHERE id = $1", [req.params.id]);

    if (result.rowCount === 0) {
      span.setTag("task.found", false);
      return res.status(404).json({ error: "Not found" });
    }

    span.setTag("task.found", true);
    res.json(result.rows[0]);
  });
});
```

Key points:

- The callback receives the active `span` as its first argument.
- Returning an `async` function (or a `Promise`) makes the span cover the full asynchronous lifetime.
- Errors thrown inside the callback are automatically tagged on the span with `error.message`, `error.type`, and `error.stack`.

### 2 — `tracer.startSpan()` + manual finish

Use this when you need full control, e.g. when the span must live beyond a single function or you need to pass it around.

```javascript
async function handleTaskEvent(event) {
  const span = tracer.startSpan("worker.handle_task_event", {
    resource: event?.type ?? "unknown",
    tags: { "task.id": event?.payload?.id },
  });

  try {
    const result = await tracer.scope().activate(span, async () => {
      // Any auto-instrumented call made here (pg, http, etc.)
      // is parented to this span automatically.
      await db.query("UPDATE tasks SET status = $1 WHERE id = $2", [
        "queued",
        event.payload.id,
      ]);
      return { status: "queued" };
    });

    span.setTag("task.status", result.status);
  } catch (error) {
    span.setTag("error", error);
    throw error;
  } finally {
    span.finish();
  }
}
```

Key points:

- **Always call `span.finish()`** — without it the span is silently dropped.
- **Activate the span** with `tracer.scope().activate(span, fn)` so that any auto-instrumented call inside `fn` (database queries, HTTP requests) becomes a child span of your custom span.
- Place `span.finish()` in a `finally` block so it runs even on error.

### 3 — Nested child spans

Create explicit parent-child relationships with the `childOf` option:

```javascript
async function enrichTask(task, parentSpan) {
  const span = tracer.startSpan("tasks.enrich", {
    childOf: parentSpan,
    tags: { "task.id": task.id },
  });

  try {
    await tracer.scope().activate(span, async () => {
      const metadata = await fetchExternalMetadata(task.id);
      await db.query("UPDATE tasks SET description = $1 WHERE id = $2", [
        metadata.description,
        task.id,
      ]);
    });
    span.setTag("enrich.success", true);
  } catch (error) {
    span.setTag("error", error);
  } finally {
    span.finish();
  }
}
```

When you omit `childOf`, `startSpan` uses the currently active span from `tracer.scope().active()`. Passing `childOf` explicitly is useful when the parent is not the currently active scope (e.g. the span was created elsewhere and passed as an argument).

### 4 — Context propagation across a message queue

In an event-driven architecture the producer and consumer run in different contexts (often different processes). To connect them into a single distributed trace, **inject** the trace context into message headers on the publish side and **extract** it on the consume side.

#### Producer (inject)

```javascript
async function publishTaskEvent(payload) {
  const headers = {};
  const span = tracer.scope().active();

  if (span) {
    tracer.inject(span.context(), "text_map", headers);
  }

  channel.sendToQueue(
    queueName,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true, headers }
  );
}
```

`tracer.inject()` serialises the active span's trace ID, span ID, and sampling priority into the `headers` object. AMQP message headers travel with the message to the consumer.

#### Consumer (extract)

```javascript
channel.consume(queueName, (msg) => {
  if (!msg) return;

  const parentContext = tracer.extract("text_map", msg.properties.headers || {});
  const content = JSON.parse(msg.content.toString());

  const span = tracer.startSpan("worker.handle_task_event", {
    childOf: parentContext || undefined,
    resource: content?.type ?? "unknown",
    tags: { "task.id": content?.payload?.id },
  });

  tracer.scope().activate(span, async () => {
    try {
      await handler(content);
    } catch (error) {
      span.setTag("error", error);
    } finally {
      span.finish();
      channel.ack(msg);
    }
  });
});
```

With inject/extract, every span the consumer creates is attached to the same trace that the HTTP request initiated, giving you a single flame graph from the REST call all the way through the message queue to the worker.

### 5 — Span links (loosely-coupled async)

When a consumer processes messages from **multiple** producers (batch processing, fan-in), a strict parent-child relationship doesn't make sense. Use **span links** instead:

```javascript
channel.consume(queueName, (msg) => {
  if (!msg) return;

  const producerContext = tracer.extract("text_map", msg.properties.headers || {});
  const links = producerContext ? [{ context: producerContext }] : [];

  const span = tracer.startSpan("worker.batch_process", {
    links,
    tags: { "batch.source": "rabbitmq" },
  });

  tracer.scope().activate(span, async () => {
    try {
      await processBatch(JSON.parse(msg.content.toString()));
    } catch (error) {
      span.setTag("error", error);
    } finally {
      span.finish();
      channel.ack(msg);
    }
  });
});
```

Span links appear in the Datadog Trace Explorer as "Related Spans" rather than as parents, which is the correct semantic for loosely-coupled or batched async work.

### 6 — Wrapping utility functions with `tracer.wrap()`

If you have a plain function you want traced every time it's called:

```javascript
const fetchExternalMetadata = tracer.wrap(
  "external.metadata_fetch",
  { resource: "metadata-api" },
  async function fetchExternalMetadata(taskId) {
    const res = await fetch(`https://metadata.internal/api/tasks/${taskId}`);
    return res.json();
  }
);
```

`tracer.wrap()` returns a new function with the same signature. Each invocation creates and finishes a span automatically, and async/promise return values are respected.

### 7 — Error handling best practices

| Pattern | How errors surface |
| --- | --- |
| `tracer.trace(name, async (span) => { ... })` | Errors thrown inside the callback are **automatically** tagged on the span. |
| `tracer.startSpan()` + manual finish | You **must** call `span.setTag("error", error)` yourself before `span.finish()`. |
| `tracer.wrap()` | Behaves like `tracer.trace()` — errors are auto-captured. |

For `startSpan`, a resilient pattern:

```javascript
const span = tracer.startSpan("my.operation");
try {
  await tracer.scope().activate(span, () => doWork());
} catch (error) {
  span.setTag("error", error);
  throw error;
} finally {
  span.finish();
}
```

### 8 — Common pitfalls

| Pitfall | Fix |
| --- | --- |
| Span never appears in Datadog | You forgot `span.finish()`. Always use `finally`. |
| Child spans are orphaned (appear as separate traces) | The parent span is not active in the current scope. Use `tracer.scope().activate(parentSpan, fn)` or pass `childOf` explicitly. |
| `async/await` loses scope | `scope.bind()` does **not** work with bare `async/await`. Wrap the awaited promise in a function passed to `scope.activate()`. |
| Queue consumer spans are disconnected from producer | You are not injecting/extracting context via message headers. See §4 above. |
| Excessive span volume | Don't create a span for every trivial operation. Span custom work like queue processing, external API calls, or business-logic steps that you want visible in flame graphs. |

### Quick-reference cheat sheet

```text
┌────────────────────────────────────────────────────────────────┐
│  PATTERN               USE WHEN                               │
├────────────────────────────────────────────────────────────────┤
│  tracer.trace()        One-shot async work within a handler.  │
│                        Span auto-finishes, errors auto-tagged.│
│                                                                │
│  tracer.startSpan()    Span must outlive a single callback or │
│  + scope.activate()    be passed between functions.            │
│  + span.finish()       You handle errors and finish manually.  │
│                                                                │
│  tracer.wrap()         Reusable utility function that should  │
│                        always produce a span on each call.     │
│                                                                │
│  inject / extract      Propagate context across process or    │
│                        transport boundaries (queues, HTTP).    │
│                                                                │
│  span links            Connect spans from multiple producers  │
│                        without a strict parent-child tree.     │
└────────────────────────────────────────────────────────────────┘
```

---

## Datadog DBM process flowchart (customer version)

If you need to explain how Datadog Database Monitoring is rolled out across different database types, use:

- `infrastructure/DATADOG_DBM_FLOWCHART.md`

It includes:

- A single end-to-end flowchart with decision branches by database type.
- Setup checkpoints for PostgreSQL, MySQL or MariaDB, SQL Server, Oracle, MongoDB, and managed cloud databases.
- A simple customer talk track and validation checklist.
