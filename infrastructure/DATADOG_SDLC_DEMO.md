# Datadog SDLC Demo: Developer Pain Point + Workflow Automation

This demo tells a full SDLC story around a realistic developer pain point:

> **"Queue worker failures are hard to spot and often acknowledged too early, so tasks silently stall without clear ownership."**

The repository now includes retry + dead-letter handling in the backend worker, plus automation assets to run and validate the scenario.

---

## What changed in this repo for the demo

### Backend reliability + observability

- Worker retries failed queue events (`WORKER_MAX_RETRIES`, default `3`).
- Exhausted events are moved to a dead-letter queue (`task_events.dead_letter`).
- Tasks record worker state:
  - `worker_attempts`
  - `last_error`
  - `status=failed` when retries are exhausted
- Datadog trace spans include retry metadata:
  - `worker.retry_count`
  - `worker.max_retries`
- Controlled failure simulation is available through env vars:
  - `WORKER_FAILURE_SIMULATION_ENABLED=true|false`
  - `WORKER_FAILURE_KEYWORD=[fail-worker]`

### Workflow automation

- **Local/EC2 script:** `scripts/datadog_painpoint_demo.sh`
- **CI workflow:** `.github/workflows/sdlc-painpoint-demo.yml`

The script can run two paths:
- **Happy path**: task is queued successfully.
- **Pain point path**: simulated worker failures trigger retries and final failed state.

---

## SDLC narrative you can present

Use this flow in customer/internal demos:

1. **Plan/Build**
   - Dev ships feature relying on async worker processing.
2. **Detect**
   - Datadog traces/logs show repeated worker failures on `TASK_CREATED`.
3. **Investigate**
   - Correlate span tags + task metadata (`worker_attempts`, `last_error`).
4. **Mitigate**
   - Automatic retries reduce transient failures.
5. **Contain**
   - Dead-letter queue preserves exhausted events for safe replay/analysis.
6. **Automate**
   - CI workflow executes demo checks continuously to prevent regression.

---

## Prerequisites

1. Docker + Docker Compose plugin installed.
2. `curl` and `jq` installed (needed by `scripts/datadog_painpoint_demo.sh`).
3. Datadog API key configured (if you want traces in Datadog UI):
   - `cp .env.datadog.example datadog.env`
   - Fill `DD_API_KEY`, `DD_SITE`, etc.

---

## Run the demo locally

From repo root:

```bash
# 1) Start stack (with Datadog agent)
docker compose --env-file datadog.env \
  -f docker-compose.yml \
  -f docker-compose.datadog.yml \
  up -d --build

# 2) Happy path: worker succeeds
./scripts/datadog_painpoint_demo.sh --mode happy

# 3) Pain point simulation: worker fails/retries/exhausts
docker compose --env-file datadog.env \
  -f docker-compose.yml \
  -f docker-compose.datadog.yml \
  stop backend
docker compose --env-file datadog.env \
  -f docker-compose.yml \
  -f docker-compose.datadog.yml \
  run -d --name three-tier-backend-failure \
  -e WORKER_FAILURE_SIMULATION_ENABLED=true \
  backend
./scripts/datadog_painpoint_demo.sh --mode failure

# 4) Restore normal backend container
docker rm -f three-tier-backend-failure
docker compose --env-file datadog.env \
  -f docker-compose.yml \
  -f docker-compose.datadog.yml \
  up -d backend

# 5) Tear down (optional)
docker compose down -v
```

Expected results:

- Happy path: task status transitions to `queued`.
- Pain path: task transitions to `failed` after retries, with `worker_attempts` and `last_error` populated.
- RabbitMQ dead-letter queue receives exhausted event payload.

---

## Validate in Datadog

1. Go to **APM -> Services -> three-tier-backend**.
2. Open traces containing `worker.handle_task_event`.
3. Verify span tags:
   - `worker.retry_count`
   - `worker.max_retries`
4. In Logs, filter for:
   - `queue-retry`
   - `queue-exhausted`
5. (Optional) Build a monitor on repeated `queue-exhausted` logs to page on-call.

---

## CI integration

The GitHub Actions workflow `.github/workflows/sdlc-painpoint-demo.yml` runs on pushes and PRs:

- Uses Docker Compose to start Postgres, RabbitMQ, and backend with worker simulation enabled.
- Executes the failure path using `scripts/datadog_painpoint_demo.sh --mode failure`.
- Fails if the task does not end in `failed` state after retries.

This demonstrates **automation as code** in the SDLC loop.

---

## Suggested talk track (short)

- "We intentionally trigger a developer pain point: async worker failures."
- "Datadog shows the failure pattern quickly through traces/logs."
- "The system now self-heals for transient issues via retries."
- "When failure persists, events are safely dead-lettered and state is explicit."
- "CI continuously validates this behavior so reliability doesn’t regress."
