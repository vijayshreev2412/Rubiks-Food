# Three-tier Task Processing App

React frontend ⟷ Node.js/Express REST API ⟷ PostgreSQL, with RabbitMQ handling the asynchronous communication path. The stack is containerized for repeatable local development and deployment to Amazon EC2.

## Architecture

- **Frontend (`frontend/`)** – Vite + React single-page app for creating and managing tasks.
- **Backend (`backend/`)** – Express API that persists data, exposes REST endpoints, and publishes/consumes RabbitMQ events.
- **Database** – PostgreSQL (`tasks` table) stores task metadata and status transitions.
- **Queue** – RabbitMQ broker + management UI; the API publishes `TASK_*` events and a lightweight worker loop consumes them to simulate asynchronous processing (e.g., automatically moving new tasks into a `queued` state).
- **Orchestration** – Docker Compose spins up all four services plus supporting volumes. Each service is also runnable on its own for iterative development.

```
React (Vite) ──HTTP──> Express API ──SQL──> PostgreSQL
      │                               │
      └──────────────HTTP─────────────┘

Express API ──AMQP publish/consume──> RabbitMQ queue (task_events)
```

## Repository layout

```
backend/                Node.js service, Express routes, RabbitMQ + Postgres clients
frontend/               React client (Vite) with API helper + UI
docker-compose.yml      Local/dev container orchestration
infrastructure/         Deployment runbooks and IaC placeholders
```

## Backend quick reference

- `POST /api/tasks` – creates a task, persists it, and publishes `TASK_CREATED`.
- `GET /api/tasks` – lists the most recent tasks.
- `PATCH /api/tasks/:id/status` – updates the task status and emits `TASK_STATUS_CHANGED`.
- `GET /health` – returns service health metadata.

The worker loop inside `backend/src/index.js` consumes RabbitMQ events:

- On `TASK_CREATED` it marks the DB record as `queued` to emulate background work kicking in.
- On `TASK_STATUS_CHANGED` it simply logs, but this is the place to fan out notifications or downstream pipelines.

Set your env variables by copying `.env.example` to `.env` inside both `backend/` and `frontend/` (only needed when running outside Docker):

```
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

### Run the backend without containers

```bash
cd backend
npm install
npm run dev
```

You will also need PostgreSQL and RabbitMQ running locally. The easiest path is to start them with Docker (see next section) or use managed instances and point `DATABASE_URL` / `RABBITMQ_URL` accordingly.

## Frontend quick reference

- Create tasks, view statuses, and trigger status updates.
- The UI is API-driven; it reads `VITE_API_BASE_URL` (or defaults to the same host on port `4000`) to know where to send HTTP calls.

Run without Docker:

```bash
cd frontend
npm install
npm run dev
```

## Local development with Docker Compose

```bash
docker compose up --build
```

Services exposed by default:

| Service    | Endpoint             | Notes                                      |
| ---------- | -------------------- | ------------------------------------------ |
| Frontend   | http://localhost:5173 | Static build served via Nginx              |
| API        | http://localhost:4000 | Express REST API                           |
| PostgreSQL | localhost:5432        | Credentials `postgres` / `postgres`        |
| RabbitMQ   | amqp://localhost:5672 | Default guest credentials                  |
| RabbitMQ UI| http://localhost:15672| Username `guest`, password `guest`         |

Useful commands:

- `docker compose logs -f backend` – follow API + worker logs (shows queue events).
- `docker compose exec postgres psql -U postgres -d tasks_db -c "select * from tasks;"` – inspect stored tasks.
- `docker compose down -v` – tear down the stack and remove data volumes.

## Deployment to Amazon EC2

The repo is deployment-ready using the same Docker Compose file. Below is a lightweight runbook for Ubuntu 22.04+:

1. **Provision the instance**
   - Launch an EC2 instance (t3.small or better) running Ubuntu 22.04.
   - Open inbound ports 80 (frontend), 4000 (API), 5672 (RabbitMQ AMQP), and 15672 (RabbitMQ UI) or tighten as needed behind an ALB/NGINX proxy.

2. **Install prerequisites**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker
```

3. **Clone and configure**

```bash
git clone <repo-url> /opt/three-tier-app
cd /opt/three-tier-app
cp backend/.env.example backend/.env      # adjust PORT, DATABASE_URL if required
cp frontend/.env.example frontend/.env    # set VITE_API_BASE_URL to http://<EC2_PUBLIC_IP>:4000
```

4. **Build & run**

```bash
docker compose up -d --build
docker compose ps
```

5. **System hardening / persistence**
   - Create an `A` record or load balancer pointing to the EC2 public IP.
   - Optionally add an NGINX reverse proxy on port 80/443 to front both the API and static site.
   - Use `docker compose logs -f` for troubleshooting and `docker compose pull` to deploy updates.

6. **Verification**
   - Hit `http://<EC2_PUBLIC_IP>:5173` (or 80 if you change the mapping) to load the React app.
   - Create a task, watch status move from `pending` → `queued` in seconds.
   - Check `http://<EC2_PUBLIC_IP>:15672` for RabbitMQ UI (guest/guest) to inspect the `task_events` queue.

## RabbitMQ usage notes

- Queue name defaults to `task_events` and can be overridden through `RABBITMQ_QUEUE`.
- Messages are JSON envelopes with `type` + `payload`.
- The demo worker inside the backend consumes directly; for a real workload, extract that logic into a separate `worker` service and reuse the existing connection helper in `src/rabbitmq.js`.

## Next steps / customizations

- Add authentication to the API and UI.
- Extend the worker so that messages trigger long-running jobs or integrate with other systems.
- Replace Docker Compose with ECS, EKS, or Terraform-managed infrastructure if you need multi-node scale.
- Wire up CI/CD (e.g., GitHub Actions building/pushing images to ECR, then redeploying the compose stack on EC2).

## Observability

- **APM with Datadog** – The backend now includes `dd-trace` instrumentation (auto + custom spans). Use the override file `docker-compose.datadog.yml` together with `docker-compose.yml` to launch the Datadog Agent sidecar:

  ```bash
  cp .env.datadog.example datadog.env   # set DD_API_KEY, DD_SITE, etc.
  docker compose --env-file datadog.env \
    -f docker-compose.yml \
    -f docker-compose.datadog.yml \
    up -d --build
  ```

  See `infrastructure/DATADOG.md` for the full step-by-step guide, production tips, and validation checklist.

Happy shipping! 🚀
