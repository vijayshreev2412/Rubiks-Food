# Local Meteor + Datadog tracing test harness

This runbook gives you a clean local Meteor app that validates all of these at once:

- multiple Meteor methods
- method calling another method (nested calls)
- DB calls made inside methods
- one-time Datadog tracer initialization
- one-time monkey wrapping of `Meteor.methods`
- span lifecycle using `Meteor.beforeAllMethods` and `Meteor.afterAllMethods`

> The setup is DB-client agnostic for tracing context propagation.  
> The sample app uses Meteor's MongoDB path for an easy local DB.

---

## 1) Prerequisites

- Docker (for Datadog Agent)
- Meteor CLI
- Datadog API key (to see traces in Datadog UI)

Install Meteor (Linux/macOS):

```bash
curl https://install.meteor.com/ | sh
```

---

## 2) Start Datadog Agent locally

```bash
docker run -d --name dd-agent \
  -e DD_API_KEY="<YOUR_DD_API_KEY>" \
  -e DD_SITE="datadoghq.com" \
  -e DD_APM_ENABLED=true \
  -e DD_LOGS_ENABLED=false \
  -p 8126:8126 \
  gcr.io/datadoghq/agent:7
```

Check agent health:

```bash
docker logs dd-agent --tail 50
```

---

## 3) Create a local Meteor app

```bash
meteor create meteor-ddtrace-lab
cd meteor-ddtrace-lab
meteor add msavin:method-hooks
meteor npm install dd-trace@latest
```

---

## 4) Replace `server/main.js`

Use this exact file so tracing hooks are loaded first.

```js
"use strict";

// Must run first so dd-trace can patch modules early.
require("../imports/startup/server/datadog-method-hooks");

// Register methods after monkey wrapping is installed.
require("../imports/api/methods");
```

---

## 5) Create `imports/startup/server/datadog-method-hooks.js`

```js
"use strict";

const { Meteor } = require("meteor/meteor");

const METHOD_SPAN_NAME = "meteor.method";
const MAX_ARGS_LENGTH = 1024;

function safeStringify(value) {
  try {
    const out = JSON.stringify(value);
    return out.length > MAX_ARGS_LENGTH
      ? `${out.slice(0, MAX_ARGS_LENGTH)}...[truncated]`
      : out;
  } catch (_err) {
    return "[unserializable]";
  }
}

function getMethodId(ctx) {
  return (
    ctx?._methodId ||
    ctx?.methodId ||
    ctx?._message?.id ||
    ctx?._ddpMessage?.id ||
    undefined
  );
}

// ---- one-time tracer init ----
if (!global.__ddTracer) {
  global.__ddTracer = require("dd-trace").init({
    service: process.env.DD_SERVICE || "meteor-ddtrace-lab",
    env: process.env.DD_ENV || "local",
    version: process.env.DD_VERSION || "0.0.1",
    logInjection: process.env.DD_LOGS_INJECTION === "true",
  });
}

const tracer = global.__ddTracer;

function wrapMethodHandler(handler) {
  if (typeof handler !== "function" || handler.__ddWrapped) {
    return handler;
  }

  function wrappedHandler(...args) {
    const methodSpan = this?._ddSpan;
    if (!methodSpan) {
      return handler.apply(this, args);
    }

    // Key point: execute actual method body in active scope.
    return tracer.scope().activate(methodSpan, () => {
      try {
        const result = handler.apply(this, args);
        if (result && typeof result.then === "function") {
          return result.catch((err) => {
            methodSpan.setTag("error", err);
            throw err;
          });
        }
        return result;
      } catch (err) {
        methodSpan.setTag("error", err);
        throw err;
      }
    });
  }

  wrappedHandler.__ddWrapped = true;
  return wrappedHandler;
}

// ---- one-time monkey wrap of Meteor.methods ----
if (!global.__ddMeteorMethodsMonkeyPatched) {
  const originalMeteorMethods = Meteor.methods;

  Meteor.methods = function patchedMeteorMethods(methodMap) {
    const wrappedMap = {};
    for (const [name, fn] of Object.entries(methodMap || {})) {
      wrappedMap[name] = wrapMethodHandler(fn);
    }
    return originalMeteorMethods.call(this, wrappedMap);
  };

  global.__ddMeteorMethodsMonkeyPatched = true;
}

// Also wrap methods that may already exist.
const existingHandlers = Meteor?.server?.method_handlers || {};
for (const name of Object.keys(existingHandlers)) {
  existingHandlers[name] = wrapMethodHandler(existingHandlers[name]);
}

// ---- one-time hook registration ----
if (!global.__ddMeteorMethodHooksInstalled) {
  Meteor.beforeAllMethods(function (...args) {
    const methodName = this?._methodName || "unknown";
    const connectionId = this?.connection?.id;
    const userId = this?.userId;
    const methodId = getMethodId(this);
    const parentSpan = tracer.scope().active();

    this._ddSpan = tracer.startSpan(METHOD_SPAN_NAME, {
      resource: methodName,
      childOf: parentSpan || undefined,
      tags: {
        "meteor.method": methodName,
        component: "meteor",
        ...(connectionId ? { "meteor.connection_id": connectionId } : {}),
        ...(userId ? { "meteor.user_id": String(userId) } : {}),
        ...(methodId ? { "meteor.method_id": String(methodId) } : {}),
        "meteor.method_args": safeStringify(args),
      },
    });
  });

  Meteor.afterAllMethods(function () {
    const span = this?._ddSpan;
    if (!span) return;

    if (this.error) {
      span.setTag("error", this.error);
    }

    span.finish();
    this._ddSpan = null;
  });

  global.__ddMeteorMethodHooksInstalled = true;
}
```

---

## 6) Create `imports/api/methods.js`

This file gives you:

- several methods with DB operations
- nested method call chains
- one orchestrator method for repeated trace generation

```js
"use strict";

const { Meteor } = require("meteor/meteor");
const { Mongo } = require("meteor/mongo");
const { Random } = require("meteor/random");

const TraceTasks = new Mongo.Collection("trace_tasks");

async function callMethodCompat(name, ...args) {
  if (typeof Meteor.callAsync === "function") {
    return Meteor.callAsync(name, ...args);
  }

  return new Promise((resolve, reject) => {
    Meteor.call(name, ...args, (err, res) => {
      if (err) return reject(err);
      return resolve(res);
    });
  });
}

Meteor.methods({
  async "trace.db.insert"(traceKey) {
    const key = traceKey || `trace-${Random.id(10)}`;
    await TraceTasks.rawCollection().insertOne({
      traceKey: key,
      status: "created",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { traceKey: key };
  },

  async "trace.db.lookup"(traceKey) {
    const doc = await TraceTasks.rawCollection().findOne({ traceKey });
    return { found: Boolean(doc), traceKey };
  },

  async "trace.db.update"(traceKey, status) {
    const nextStatus = status || "done";
    const result = await TraceTasks.rawCollection().updateOne(
      { traceKey },
      {
        $set: {
          status: nextStatus,
          updatedAt: new Date(),
        },
      }
    );
    return { matched: result.matchedCount, modified: result.modifiedCount };
  },

  async "trace.child.method"(traceKey) {
    await TraceTasks.rawCollection().findOne({ traceKey });
    await TraceTasks.rawCollection().updateOne(
      { traceKey },
      { $set: { childTouchedAt: new Date() } }
    );
    return { child: true, traceKey };
  },

  async "trace.parent.method"(traceKey) {
    const lookup = await callMethodCompat("trace.db.lookup", traceKey);
    const child = await callMethodCompat("trace.child.method", traceKey);
    await TraceTasks.rawCollection().updateOne(
      { traceKey },
      { $set: { parentTouchedAt: new Date() } }
    );
    return { parent: true, lookup, child, traceKey };
  },

  async "trace.runScenario"() {
    const traceKey = `scenario-${Random.id(8)}`;

    await callMethodCompat("trace.db.insert", traceKey);
    const parent = await callMethodCompat("trace.parent.method", traceKey);
    const update = await callMethodCompat("trace.db.update", traceKey, "completed");

    return { traceKey, parent, update };
  },
});
```

---

## 7) Run app with Datadog env vars

```bash
DD_AGENT_HOST=127.0.0.1 \
DD_TRACE_AGENT_PORT=8126 \
DD_TRACE_ENABLED=true \
DD_TRACE_DEBUG=true \
DD_SERVICE=meteor-ddtrace-lab \
DD_ENV=local \
DD_VERSION=0.0.1 \
meteor
```

---

## 8) Generate traces (nested methods + DB calls)

In a second terminal:

```bash
cd meteor-ddtrace-lab
meteor shell
```

Inside `meteor shell`:

```js
await Meteor.callAsync("trace.runScenario");
await Meteor.callAsync("trace.runScenario");
await Meteor.callAsync("trace.runScenario");
```

If your Meteor version does not support `callAsync`, use:

```js
Meteor.call("trace.runScenario", (e, r) => console.log(e || r));
```

---

## 9) Verify in Datadog

1. Open **APM -> Services** and select `meteor-ddtrace-lab`.
2. Search traces containing resource names:
   - `trace.runScenario`
   - `trace.parent.method`
   - `trace.child.method`
   - `trace.db.insert` / `trace.db.lookup` / `trace.db.update`
3. Open one trace and confirm:
   - parent/child relation between method spans
   - DB spans are children of the currently active method span

---

## 10) Troubleshooting

- **No DB spans**:
  - ensure `require("../imports/startup/server/datadog-method-hooks")` is first in `server/main.js`
  - ensure dd-trace is initialized once (global guard in this runbook)
  - verify `DD_TRACE_ENABLED=true` and agent reachable on `127.0.0.1:8126`
- **Duplicate method spans**:
  - confirm global flags are present:
    - `__ddMeteorMethodsMonkeyPatched`
    - `__ddMeteorMethodHooksInstalled`
- **No traces in Datadog**:
  - check `docker logs dd-agent --tail 200`
  - confirm API key/site values

---

With this harness, you can repeatedly validate method nesting and DB child spans without changing your production app first.
