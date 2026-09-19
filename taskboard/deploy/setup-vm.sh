#!/usr/bin/env bash
# Provision this project on a fresh Ubuntu 22.04/24.04 VM (no Kubernetes, no containers).
# Usage (from the project root):  sudo ./deploy/setup-vm.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/taskboard; WEB_DIR=/var/www/taskboard; CONF_DIR=/etc/taskboard; UPLOAD_DIR=/var/lib/taskboard/uploads

DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 16)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(openssl rand -hex 16)}"
ADMIN_API_KEY="${ADMIN_API_KEY:-$(openssl rand -hex 16)}"

echo "==> Installing packages"
apt-get update -y
apt-get install -y curl ca-certificates openssl nginx postgresql redis-server
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> PostgreSQL"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='taskboard'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER taskboard"
sudo -u postgres psql -c "ALTER USER taskboard WITH PASSWORD '${DB_PASSWORD}'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='taskboard'" | grep -q 1 \
  || sudo -u postgres createdb -O taskboard taskboard

echo "==> Redis (password protected)"
if grep -q '^requirepass' /etc/redis/redis.conf; then
  sed -i "s/^requirepass.*/requirepass ${REDIS_PASSWORD}/" /etc/redis/redis.conf
else
  echo "requirepass ${REDIS_PASSWORD}" >> /etc/redis/redis.conf
fi
systemctl restart redis-server

echo "==> Backend"
id taskboard &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin taskboard
mkdir -p "$APP_DIR" "$UPLOAD_DIR" "$CONF_DIR"
cp -r "$ROOT/backend/." "$APP_DIR/"
cp "$ROOT/deploy/run-job.sh" "$APP_DIR/run-job.sh"; chmod +x "$APP_DIR/run-job.sh"
(cd "$APP_DIR" && npm install --omit=dev)
chown -R taskboard:taskboard "$APP_DIR" /var/lib/taskboard

cat > "$CONF_DIR/app.env" <<EOF
APP_ENV=production
APP_NAME=TaskBoard
APP_VERSION=1.0.0
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=taskboard
DB_USER=taskboard
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
CACHE_TTL_SECONDS=30
UPLOAD_DIR=${UPLOAD_DIR}
MAX_UPLOAD_MB=5
ENABLE_UPLOADS=true
ENABLE_LOAD_ENDPOINT=true
DONE_RETENTION_DAYS=7
EOF
cat > "$CONF_DIR/secrets.env" <<EOF
DB_PASSWORD=${DB_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
ADMIN_API_KEY=${ADMIN_API_KEY}
EOF
chmod 644 "$CONF_DIR/app.env"; chown root:taskboard "$CONF_DIR/secrets.env"; chmod 640 "$CONF_DIR/secrets.env"

echo "==> Database migration"
sudo -u taskboard "$APP_DIR/run-job.sh" migrate

echo "==> systemd service + nightly cleanup (cron)"
cp "$ROOT/deploy/taskboard-backend.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now taskboard-backend
echo '0 2 * * * taskboard /opt/taskboard/run-job.sh cleanup 2>&1 | logger -t taskboard-cleanup' > /etc/cron.d/taskboard-cleanup

echo "==> Frontend + nginx"
mkdir -p "$WEB_DIR"; cp -r "$ROOT/frontend/." "$WEB_DIR/"
cp "$ROOT/deploy/nginx.conf" /etc/nginx/sites-available/taskboard
ln -sf /etc/nginx/sites-available/taskboard /etc/nginx/sites-enabled/taskboard
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo
echo "Done. Open  http://<this-VM-ip>/   (allow port 80 in your firewall / cloud security group)"
echo "Admin API key: ${ADMIN_API_KEY}   (also stored in ${CONF_DIR}/secrets.env)"
