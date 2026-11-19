#!/usr/bin/env bash
# Runs on the VM (Ubuntu 22.04/24.04). Installs Node and Caddy once, then
# rebuilds and restarts the service. Caddy gets the HTTPS cert automatically.
set -euo pipefail
cd ~/piper

DOMAIN=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2- | sed -E 's#^https?://##; s#/.*##')
[ -n "$DOMAIN" ] || { echo "PUBLIC_BASE_URL not set in .env" >&2; exit 1; }

# Oracle's 1 GB micro shape can't run tsc without swap.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 2000 ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update && sudo apt-get install -y caddy
fi

# Oracle's Ubuntu images reject all inbound traffic except SSH at the host
# firewall, on top of the cloud security list.
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

npm ci --no-audit --no-fund
npm run build

sudo tee /etc/systemd/system/piper.service >/dev/null <<EOF
[Unit]
Description=piper
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/piper
ExecStart=/usr/bin/node --enable-source-maps dist/main.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

printf '%s {\n  reverse_proxy localhost:3000\n}\n' "$DOMAIN" | sudo tee /etc/caddy/Caddyfile >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now caddy piper >/dev/null 2>&1
sudo systemctl restart piper
sudo systemctl reload caddy

for _ in $(seq 1 20); do curl -fsS localhost:3000/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS localhost:3000/health && echo " piper is up at https://$DOMAIN"
