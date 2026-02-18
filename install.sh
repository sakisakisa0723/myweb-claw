#!/usr/bin/env bash
# ==============================================================================
#  OpenClaw WebUI — One-click installer
#  Usage: bash <(curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-webui/main/install.sh)
# ==============================================================================
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo -e "${CYAN}  ℹ  ${RESET}$*"; }
success() { echo -e "${GREEN}  ✔  ${RESET}$*"; }
warn()    { echo -e "${YELLOW}  ⚠  ${RESET}$*"; }
error()   { echo -e "${RED}  ✖  ${RESET}$*" >&2; }
step()    { echo -e "\n${BOLD}${BLUE}▶ $*${RESET}"; }
ask()     { echo -en "${YELLOW}  ?  ${RESET}$* "; }

die() {
  error "$*"
  exit 1
}

banner() {
  echo -e "${BOLD}${CYAN}"
  cat <<'EOF'
   ___                  _____ _                  __        __   _     _   _ ___
  / _ \ _ __   ___ _ _|_   _| | __ ___      __ \ \      / /__| |__ | | | |_ _|
 | | | | '_ \ / _ \ '_ \| | | |/ _` \ \ /\ / /  \ \ /\ / / _ \ '_ \| | | || |
 | |_| | |_) |  __/ | | | | | | (_| |\ V  V /    \ V  V /  __/ |_) | |_| || |
  \___/| .__/ \___|_| |_|_| |_|\__,_| \_/\_/      \_/\_/ \___|_.__/ \___/|___|
       |_|
EOF
  echo -e "${RESET}"
  echo -e "  ${DIM}A standalone Web chat interface for OpenClaw Gateway${RESET}"
  echo -e "  ${DIM}https://github.com/openclaw/openclaw-webui${RESET}\n"
}

# ── Repo / install directory ──────────────────────────────────────────────────
REPO_URL="https://github.com/openclaw/openclaw-webui.git"
DEFAULT_INSTALL_DIR="$HOME/openclaw-webui"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 0: Banner
# ─────────────────────────────────────────────────────────────────────────────
banner

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Check Node.js
# ─────────────────────────────────────────────────────────────────────────────
step "Checking environment"

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver=$(node -e "process.exit(parseInt(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" 2>/dev/null && echo "ok" || echo "old")
  [[ "$ver" == "ok" ]]
}

if check_node; then
  NODE_VER=$(node --version)
  success "Node.js $NODE_VER detected"
else
  if command -v node &>/dev/null; then
    warn "Node.js $(node --version) is installed but OpenClaw WebUI requires Node.js >= 18."
  else
    warn "Node.js is not installed."
  fi
  echo
  echo -e "  ${BOLD}How to install Node.js 22 (LTS):${RESET}"
  echo
  echo -e "  ${DIM}# Ubuntu / Debian${RESET}"
  echo -e "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo -e "  sudo apt-get install -y nodejs"
  echo
  echo -e "  ${DIM}# CentOS / RHEL / Fedora${RESET}"
  echo -e "  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -"
  echo -e "  sudo dnf install nodejs"
  echo
  echo -e "  ${DIM}# macOS (Homebrew)${RESET}"
  echo -e "  brew install node"
  echo
  die "Please install Node.js >= 18 and re-run this script."
fi

# Check git
if ! command -v git &>/dev/null; then
  warn "git is not installed. Attempting to install…"
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y git
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y git
  elif command -v yum &>/dev/null; then
    sudo yum install -y git
  else
    die "Cannot install git automatically. Please install git and re-run."
  fi
fi
success "git $(git --version | awk '{print $3}') detected"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Download / update project
# ─────────────────────────────────────────────────────────────────────────────
step "Setting up project files"

ask "Install directory [${DEFAULT_INSTALL_DIR}]: "
read -r INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing repository found at $INSTALL_DIR"
  ask "Pull latest updates? [Y/n]: "
  read -r DO_PULL
  if [[ ! "${DO_PULL:-y}" =~ ^[Nn]$ ]]; then
    git -C "$INSTALL_DIR" pull --ff-only && success "Repository updated" || warn "Could not pull (may have local changes)"
  fi
elif [[ -d "$INSTALL_DIR" ]] && [[ "$(ls -A "$INSTALL_DIR")" ]]; then
  warn "Directory $INSTALL_DIR exists and is not empty."
  ask "Use it anyway (skip clone)? [y/N]: "
  read -r USE_EXISTING
  if [[ ! "${USE_EXISTING:-n}" =~ ^[Yy]$ ]]; then
    die "Aborted. Choose a different install directory or empty the existing one."
  fi
else
  info "Cloning from $REPO_URL …"
  git clone "$REPO_URL" "$INSTALL_DIR" || die "git clone failed. Check the URL and your network connection."
  success "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: npm install
# ─────────────────────────────────────────────────────────────────────────────
step "Installing dependencies"
npm install --omit=dev 2>&1 | tail -3
success "Dependencies installed"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Interactive configuration
# ─────────────────────────────────────────────────────────────────────────────
step "Configuration"

CONFIG_FILE="$INSTALL_DIR/config.json"

# Idempotency: skip if config already exists
if [[ -f "$CONFIG_FILE" ]]; then
  # Check if it looks like a real config (has a non-empty token OR non-default name)
  EXISTING_NAME=$(node -e "try{const c=require('$CONFIG_FILE');console.log(c.gateways[0].name||'')}catch(e){}" 2>/dev/null || true)
  if [[ "$EXISTING_NAME" != "My Gateway" ]] && [[ -n "$EXISTING_NAME" ]]; then
    warn "config.json already exists (gateway: ${EXISTING_NAME})."
    ask "Reconfigure? [y/N]: "
    read -r DO_RECONFIG
    if [[ ! "${DO_RECONFIG:-n}" =~ ^[Yy]$ ]]; then
      info "Keeping existing config.json"
      SKIP_CONFIG=true
    fi
  else
    SKIP_CONFIG=false
  fi
else
  SKIP_CONFIG=false
fi

if [[ "${SKIP_CONFIG:-false}" != "true" ]]; then

  GATEWAYS_JSON="["
  FIRST_GW=true

  collect_gateway() {
    local idx="$1"
    echo
    echo -e "  ${BOLD}Gateway #${idx}${RESET}"

    ask "  Gateway URL [ws://127.0.0.1:18789]: "
    read -r GW_URL
    GW_URL="${GW_URL:-ws://127.0.0.1:18789}"

    ask "  Gateway Token: "
    read -r GW_TOKEN

    ask "  Gateway Name [My Gateway]: "
    read -r GW_NAME
    GW_NAME="${GW_NAME:-My Gateway}"

    ask "  Agent ID [main]: "
    read -r GW_AGENT
    GW_AGENT="${GW_AGENT:-main}"

    # Escape for JSON
    GW_URL_ESC=$(printf '%s' "$GW_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
    GW_TOKEN_ESC=$(printf '%s' "$GW_TOKEN" | sed 's/\\/\\\\/g; s/"/\\"/g')
    GW_NAME_ESC=$(printf '%s' "$GW_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')
    GW_AGENT_ESC=$(printf '%s' "$GW_AGENT" | sed 's/\\/\\\\/g; s/"/\\"/g')

    if [[ "$FIRST_GW" != "true" ]]; then
      GATEWAYS_JSON+=","
    fi
    GATEWAYS_JSON+="
    {
      \"name\": \"${GW_NAME_ESC}\",
      \"url\": \"${GW_URL_ESC}\",
      \"token\": \"${GW_TOKEN_ESC}\",
      \"agentId\": \"${GW_AGENT_ESC}\"
    }"
    FIRST_GW=false
  }

  collect_gateway 1

  # Ask for more gateways
  GW_IDX=2
  while true; do
    echo
    ask "  Add another gateway? [y/N]: "
    read -r ADD_MORE
    if [[ ! "${ADD_MORE:-n}" =~ ^[Yy]$ ]]; then
      break
    fi
    collect_gateway "$GW_IDX"
    (( GW_IDX++ ))
  done

  GATEWAYS_JSON+="
  ]"

  # Password
  echo
  echo -e "  ${BOLD}UI Password${RESET}"
  info "Leave blank to disable password protection."
  ask "  Password (optional): "
  read -r UI_PASSWORD
  UI_PASSWORD_ESC=$(printf '%s' "${UI_PASSWORD:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')

  # Port
  echo
  echo -e "  ${BOLD}Server Port${RESET}"
  ask "  Port [18890]: "
  read -r UI_PORT
  UI_PORT="${UI_PORT:-18890}"
  # Validate port is numeric
  if ! [[ "$UI_PORT" =~ ^[0-9]+$ ]]; then
    warn "Invalid port '$UI_PORT', defaulting to 18890"
    UI_PORT=18890
  fi

  # Write config.json
  cat > "$CONFIG_FILE" <<EOF
{
  "gateways": ${GATEWAYS_JSON},
  "port": ${UI_PORT},
  "password": "${UI_PASSWORD_ESC}",
  "models": [
    { "value": "opus46", "label": "Claude Opus 4.6" },
    { "value": "sonnet", "label": "Claude Sonnet 4.6" },
    { "value": "gemini", "label": "Gemini 2.5 Flash" },
    { "value": "pro",    "label": "Gemini 2.5 Pro" }
  ]
}
EOF
  success "config.json written"

fi  # end SKIP_CONFIG

# Re-read port from config for the rest of the script
UI_PORT=$(node -e "try{const c=require('${CONFIG_FILE}');console.log(c.port||18890)}catch(e){console.log(18890)}" 2>/dev/null || echo 18890)

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Choose startup method
# ─────────────────────────────────────────────────────────────────────────────
step "Startup method"
echo
echo -e "  ${BOLD}How would you like to run OpenClaw WebUI?${RESET}"
echo
echo -e "  ${CYAN}1)${RESET} systemd   — run as a system service (auto-start on boot), requires sudo"
echo -e "  ${CYAN}2)${RESET} screen    — run in a detached screen session"
echo -e "  ${CYAN}3)${RESET} manual    — just show me the command, I'll start it myself"
echo
ask "  Choice [1/2/3]: "
read -r STARTUP_CHOICE
STARTUP_CHOICE="${STARTUP_CHOICE:-1}"

NODE_BIN=$(command -v node)
SERVICE_NAME="openclaw-webui"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

case "$STARTUP_CHOICE" in

  1)  # ── systemd ──────────────────────────────────────────────────────────
    step "Setting up systemd service"
    if ! command -v systemctl &>/dev/null; then
      warn "systemd not found on this system. Falling back to manual startup."
      STARTUP_CHOICE=3
    else
      SUDO_CMD=""
      if [[ $EUID -ne 0 ]]; then SUDO_CMD="sudo"; fi

      $SUDO_CMD tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=OpenClaw WebUI
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
      $SUDO_CMD systemctl daemon-reload
      $SUDO_CMD systemctl enable "$SERVICE_NAME"
      $SUDO_CMD systemctl restart "$SERVICE_NAME"
      sleep 2
      if $SUDO_CMD systemctl is-active --quiet "$SERVICE_NAME"; then
        success "Service ${SERVICE_NAME} is running"
      else
        warn "Service may not have started. Check: sudo journalctl -u ${SERVICE_NAME} -n 20"
      fi
    fi
    ;;

  2)  # ── screen ───────────────────────────────────────────────────────────
    step "Starting with screen"
    if ! command -v screen &>/dev/null; then
      warn "screen not found. Installing…"
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y screen
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y screen
      elif command -v yum &>/dev/null; then
        sudo yum install -y screen
      else
        warn "Cannot install screen automatically. Falling back to manual."
        STARTUP_CHOICE=3
      fi
    fi
    if [[ "$STARTUP_CHOICE" == "2" ]]; then
      # Kill existing screen session if any
      screen -S "$SERVICE_NAME" -X quit 2>/dev/null || true
      screen -dmS "$SERVICE_NAME" bash -c "cd '${INSTALL_DIR}' && ${NODE_BIN} server.js"
      sleep 1
      if screen -list | grep -q "$SERVICE_NAME"; then
        success "Started in screen session '${SERVICE_NAME}'"
      else
        warn "Screen session may not have started correctly."
      fi
    fi
    ;;

  3|*)  # ── manual ───────────────────────────────────────────────────────
    echo
    ;;

esac

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Done!
# ─────────────────────────────────────────────────────────────────────────────

# Detect public IP for convenience
PUBLIC_IP=$(curl -sf --max-time 3 https://api.ipify.org 2>/dev/null || echo "<your-server-ip>")

echo
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║           OpenClaw WebUI is ready! 🎉                   ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo
echo -e "  ${BOLD}Access URL:${RESET}"
echo -e "    ${CYAN}http://localhost:${UI_PORT}${RESET}"
if [[ "$PUBLIC_IP" != "<your-server-ip>" ]]; then
  echo -e "    ${CYAN}http://${PUBLIC_IP}:${UI_PORT}${RESET}  ${DIM}(if firewall allows)${RESET}"
fi
echo
echo -e "  ${BOLD}Install directory:${RESET} ${INSTALL_DIR}"
echo

case "$STARTUP_CHOICE" in
  1)
    echo -e "  ${BOLD}Service commands:${RESET}"
    echo -e "    sudo systemctl status  ${SERVICE_NAME}"
    echo -e "    sudo systemctl restart ${SERVICE_NAME}"
    echo -e "    sudo systemctl stop    ${SERVICE_NAME}"
    echo -e "    sudo journalctl -fu    ${SERVICE_NAME}"
    ;;
  2)
    echo -e "  ${BOLD}Screen commands:${RESET}"
    echo -e "    screen -r ${SERVICE_NAME}          ${DIM}# attach to session${RESET}"
    echo -e "    screen -S ${SERVICE_NAME} -X quit  ${DIM}# stop${RESET}"
    echo -e "    screen -dmS ${SERVICE_NAME} bash -c \"cd '${INSTALL_DIR}' && ${NODE_BIN} server.js\"  ${DIM}# restart${RESET}"
    ;;
  3|*)
    echo -e "  ${BOLD}Start manually:${RESET}"
    echo -e "    cd ${INSTALL_DIR} && ${NODE_BIN} server.js"
    echo
    echo -e "  ${DIM}Tip: use screen or systemd for persistent operation.${RESET}"
    ;;
esac

echo
echo -e "  ${DIM}Need HTTPS? See README.md → Deployment → Behind Nginx${RESET}"
echo
