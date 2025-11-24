## EC2 Deployment Playbook

These steps target Ubuntu 22.04 LTS on a t3.small (or larger) EC2 instance and reuse the Docker Compose stack located at the repository root.

### 1. Prepare the instance

1. Launch the EC2 instance with at least 2 vCPUs / 4 GB RAM.
2. Attach a security group that allows:
   - `80/tcp` (or `5173/tcp`) for the React app.
   - `4000/tcp` for direct API access (optional if you proxy via 80/443).
   - `5672/tcp` for RabbitMQ AMQP (restrict to private networks/VPC only).
   - `15672/tcp` for the RabbitMQ management UI (limit to admins).
3. Associate an Elastic IP or record the public IPv4 address.

### 2. Install Docker + Compose plugin

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release git
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

### 3. Fetch the codebase

```bash
sudo mkdir -p /opt/three-tier-app
sudo chown $USER:$USER /opt/three-tier-app
git clone <repo-url> /opt/three-tier-app
cd /opt/three-tier-app
```

### 4. Configure environment

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

- Update `frontend/.env` → `VITE_API_BASE_URL=http://<public-ip>:4000`
- (Optional) change DB passwords, queue names, or exposed ports inside `docker-compose.yml`.

### 5. Build and launch

```bash
docker compose up -d --build
docker compose ps
```

### 6. Verify

- Visit `http://<public-ip>:5173` (or `:80` if you change the mapping) to load the React SPA.
- Use the UI to create a task; confirm it reaches `pending → queued → completed`.
- `curl http://<public-ip>:4000/api/tasks` should return JSON from the API.
- Optional: `http://<public-ip>:15672` (guest/guest) to check the `task_events` queue depth.

### 7. Ongoing operations

```bash
docker compose logs -f backend       # follow API + worker output
docker compose restart backend       # zero-downtime restarts
docker compose pull && docker compose up -d --build   # deploy updates
docker compose down                  # stop services (keep volumes)
docker compose down -v               # destroy everything (including DB data)
```

### 8. Hardening considerations

- Terminate RabbitMQ ports at the VPC level or front the stack with an ALB + security group rules.
- Add HTTPS via a reverse proxy (NGINX, Traefik, Caddy) that terminates TLS and forwards to the frontend/API containers.
- Configure system monitoring (CloudWatch agent, Prometheus, etc.) and regular backups of the PostgreSQL volume.

Once this baseline is running, you can promote the same containers to ECS/EKS or bake them into an AMI for Auto Scaling groups.

---

## Automated bootstrap script

If you prefer a single command that performs steps 2–6 for you, run the helper script once you have SSH’d into the instance:

```bash
cd /opt   # or any directory you prefer
curl -O https://raw.githubusercontent.com/<repo-owner>/<repo-name>/main/infrastructure/ec2_bootstrap.sh
chmod +x ec2_bootstrap.sh
APP_DIR=/opt/three-tier-app PUBLIC_HOST=<public-ip-or-dns> \
  ./ec2_bootstrap.sh https://github.com/<repo-owner>/<repo-name>.git main
```

Script summary:

1. Installs Docker Engine + Compose plugin using the official apt repository.
2. Clones (or pulls) the Git repository into `APP_DIR`.
3. Copies `.env.example` files and sets `VITE_API_BASE_URL=http://PUBLIC_HOST:4000`.
4. Builds and starts the Docker Compose stack, then prints useful service URLs.

The script lives at `infrastructure/ec2_bootstrap.sh` for local editing or version control review. Inspect it before running in production environments.

## Datadog APM (optional)

1. Obtain a Datadog API key and decide which site to send data to.
2. Copy `.env.datadog.example` to `datadog.env` (or export the `DD_*` variables another way) and set your secrets.
3. Launch the stack with the Datadog override file to start the Agent container and wire up tracing:

   ```bash
   docker compose --env-file datadog.env \
     -f docker-compose.yml \
     -f docker-compose.datadog.yml \
     up -d --build
   ```

4. Generate traffic, then confirm traces under **APM → Services → three-tier-backend** in the Datadog UI.

See `infrastructure/DATADOG.md` for detailed guidance, production tips, and validation steps.
