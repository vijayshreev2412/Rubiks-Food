#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./ec2_bootstrap.sh <repo-url> [branch]

Environment variables:
  APP_DIR        Target directory for the app (default: /opt/three-tier-app)
  PUBLIC_HOST    Public host or IP used for frontend VITE_API_BASE_URL (default: localhost)

Examples:
  APP_DIR=/srv/three-tier-app PUBLIC_HOST=ec2-1-2-3-4.compute.amazonaws.com \
    ./ec2_bootstrap.sh https://github.com/your-org/three-tier-app.git main
EOF
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

REPO_URL="$1"
BRANCH="${2:-main}"
APP_DIR="${APP_DIR:-/opt/three-tier-app}"
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"

echo "[1/6] Installing system prerequisites..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release git

if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
fi

if [[ ! -f /etc/apt/sources.list.d/docker.list ]]; then
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
fi

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! groups "$USER" | grep -q docker; then
  sudo usermod -aG docker "$USER"
  echo "User $USER added to docker group. Please log out/in or run 'newgrp docker' after script completes."
fi

echo "[2/6] Creating application directory at $APP_DIR..."
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "[3/6] Repository already exists. Pulling latest changes..."
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull origin "$BRANCH"
else
  echo "[3/6] Cloning repository..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "[4/6] Preparing environment files..."
if [[ ! -f backend/.env ]]; then
  cp backend/.env.example backend/.env
fi

if [[ ! -f frontend/.env ]]; then
  cp frontend/.env.example frontend/.env
fi

if grep -q '^VITE_API_BASE_URL=' frontend/.env; then
  sed -i "s|^VITE_API_BASE_URL=.*|VITE_API_BASE_URL=http://${PUBLIC_HOST}:4000|" frontend/.env
else
  echo "VITE_API_BASE_URL=http://${PUBLIC_HOST}:4000" >> frontend/.env
fi

echo "[5/6] Building and starting Docker Compose stack..."
docker compose up -d --build

echo "[6/6] Current service status:"
docker compose ps

cat <<EOF

Deployment complete!
- Frontend: http://${PUBLIC_HOST}:5173
- API health: http://${PUBLIC_HOST}:4000/health
- RabbitMQ UI: http://${PUBLIC_HOST}:15672 (guest/guest)

Use 'docker compose logs -f backend' for streaming backend logs.
EOF
