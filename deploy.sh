#!/bin/bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — Installa e avvia il tabellone su un server Hetzner
# Uso: ./deploy.sh <IP_SERVER>
# Esempio: ./deploy.sh 65.21.10.42
# ─────────────────────────────────────────────────────────────

set -e

# ── Colori ──────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓ $1${NC}"; }
info() { echo -e "${YELLOW}→ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; exit 1; }

# ── Parametri ────────────────────────────────────────────────
SERVER_IP="${1:-}"
APP_DIR="/Users/raffaelegiustini/Documents/Claude/treni"
REMOTE_DIR="/app/tabellone"
SSH_KEY="$HOME/.ssh/id_ed25519"

if [ -z "$SERVER_IP" ]; then
  echo ""
  echo "Uso: ./deploy.sh <IP_SERVER>"
  echo "Esempio: ./deploy.sh 65.21.10.42"
  echo ""
  read -p "Inserisci l'IP del server Hetzner: " SERVER_IP
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tabellone Treni & Bus — Deploy su Hetzner"
echo "  Server: $SERVER_IP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Controlla SSH key ────────────────────────────────────────
if [ ! -f "$SSH_KEY" ]; then
  info "SSH key non trovata, la genero..."
  ssh-keygen -t ed25519 -C "hetzner-tabellone" -f "$SSH_KEY" -N ""
  echo ""
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}  COPIA questa chiave pubblica su Hetzner Console:${NC}"
  echo -e "${YELLOW}  Cloud → Security → SSH Keys → Add SSH Key${NC}"
  echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  cat "$SSH_KEY.pub"
  echo ""
  read -p "Premi INVIO quando hai aggiunto la chiave su Hetzner..."
fi
ok "SSH key pronta"

# ── Testa connessione ────────────────────────────────────────
info "Testo la connessione al server..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$SSH_KEY" root@"$SERVER_IP" "echo ok" > /dev/null 2>&1 \
  || err "Impossibile connettersi a $SERVER_IP. Controlla l'IP e che la SSH key sia stata aggiunta."
ok "Connessione riuscita"

# ── Setup server (una tantum) ────────────────────────────────
info "Configuro il server (Node.js, PM2, firewall)..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@"$SERVER_IP" bash << 'ENDSSH'
set -e

# Aggiorna sistema
apt-get update -qq && apt-get upgrade -y -qq

# Installa Node.js 22
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y nodejs -qq
fi

# Installa PM2
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2 --silent
fi

# Apri porta 3456 con ufw
if command -v ufw &> /dev/null; then
  ufw allow 3456/tcp > /dev/null 2>&1 || true
fi

# Crea cartella app
mkdir -p /app/tabellone

echo "server_ready"
ENDSSH
ok "Server configurato"

# ── Copia i file ─────────────────────────────────────────────
info "Carico i file dell'app sul server..."
scp -o StrictHostKeyChecking=no -i "$SSH_KEY" \
  "$APP_DIR/server.js" \
  "$APP_DIR/index.html" \
  "$APP_DIR/bus_schedule.json" \
  root@"$SERVER_IP":"$REMOTE_DIR/"
ok "File caricati"

# ── Avvia con PM2 ────────────────────────────────────────────
info "Avvio l'app con PM2..."
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@"$SERVER_IP" bash << ENDSSH
cd $REMOTE_DIR
pm2 stop tabellone 2>/dev/null || true
pm2 delete tabellone 2>/dev/null || true
pm2 start server.js --name tabellone
pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
pm2 save
echo "pm2_done"
ENDSSH
ok "App avviata con PM2 (si riavvia automaticamente)"

# ── Verifica ─────────────────────────────────────────────────
info "Verifico che l'app risponda..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$SERVER_IP:3456/" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  ok "App online e raggiungibile"
else
  echo -e "${YELLOW}⚠ App avviata ma non risponde ancora (attendi 10 secondi e riprova)${NC}"
fi

# ── Fine ─────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  ✓ Deploy completato!${NC}"
echo ""
echo -e "  🌐 App disponibile su: ${GREEN}http://$SERVER_IP:3456${NC}"
echo ""
echo "  Comandi utili (sul server):"
echo "    pm2 status          — stato dell'app"
echo "    pm2 logs tabellone  — log in tempo reale"
echo "    pm2 restart tabellone — riavvia"
echo ""
echo "  Per aggiornare dopo modifiche:"
echo "    ./deploy.sh $SERVER_IP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
