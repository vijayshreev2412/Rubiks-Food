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
