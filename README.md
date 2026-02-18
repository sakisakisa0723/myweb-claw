# OpenClaw WebUI

A standalone Web chat interface that connects to [OpenClaw](https://github.com/openclaw/openclaw) Gateway via WebSocket. No framework, no build step — just Node.js + a single `server.js`.

<!-- Screenshot placeholder -->
<!-- ![OpenClaw WebUI Screenshot](docs/screenshot.png) -->

---

## Features

- 🔌 **WebSocket-native** — streams responses in real-time directly from OpenClaw Gateway
- 🤖 **Multi-model** — switch between Claude, Gemini, Grok, Kimi, and more on the fly
- 🌐 **Multi-Gateway** — configure multiple OpenClaw Gateway connections, switch with one click
- 🔒 **Optional UI password** — protect the interface with a simple password gate
- 📝 **Markdown rendering** — code blocks, tables, and inline formatting with syntax highlighting
- 🖼️ **Image upload** — paste or drag-and-drop images into the chat
- 📋 **Conversation history** — persistent session history in the browser
- 🚀 **Zero-dependency frontend** — pure vanilla JS, no React, no bundler
- 🐳 **Lightweight** — single Node.js process, ~1 npm dependency (`ws`)

---

## Quick Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-webui/main/install.sh)
```

This interactive script will:
1. Check for Node.js ≥ 18
2. Clone the repository
3. Walk you through Gateway configuration
4. Set up a systemd service or screen session

---

## Manual Install

```bash
# 1. Clone the repo
git clone https://github.com/openclaw/openclaw-webui.git
cd openclaw-webui

# 2. Install dependencies
npm install

# 3. Create your config (see Configuration section below)
cp config.example.json config.json
nano config.json

# 4. Start the server
node server.js
```

Open your browser at `http://localhost:18890`.

---

## Configuration

Edit `config.json` (see `config.example.json` for a template):

```json
{
  "gateways": [
    {
      "name": "My Gateway",
      "url": "ws://127.0.0.1:18789",
      "token": "your-gateway-token",
      "agentId": "main"
    }
  ],
  "port": 18890,
  "password": "",
  "models": [
    { "value": "opus46", "label": "Claude Opus 4.6" },
    { "value": "sonnet", "label": "Claude Sonnet 4.6" },
    { "value": "gemini", "label": "Gemini 2.5 Flash" },
    { "value": "pro",    "label": "Gemini 2.5 Pro" }
  ]
}
```

| Field | Description |
|---|---|
| `gateways[].name` | Display name shown in the UI switcher |
| `gateways[].url` | WebSocket URL of your OpenClaw Gateway |
| `gateways[].token` | Gateway authentication token |
| `gateways[].agentId` | Agent ID to connect to (usually `"main"`) |
| `port` | HTTP port for the WebUI (default: `18890`) |
| `password` | Optional UI password. Leave empty to disable. |
| `models` | List of models available in the model selector |

> **Note:** `config.json` is in `.gitignore` because it contains your token. Use `config.example.json` as the template and never commit your real config.

---

## Multiple Gateways

You can configure multiple gateways and switch between them in the UI:

```json
{
  "gateways": [
    {
      "name": "Local Dev",
      "url": "ws://127.0.0.1:18789",
      "token": "token-for-local",
      "agentId": "main"
    },
    {
      "name": "Production",
      "url": "ws://your-server.example.com:18789",
      "token": "token-for-prod",
      "agentId": "main"
    },
    {
      "name": "Team Gateway",
      "url": "wss://team.example.com/gateway",
      "token": "team-token",
      "agentId": "shared"
    }
  ]
}
```

A gateway selector will appear in the UI when more than one gateway is configured.

---

## Deployment

### Behind Nginx (Recommended for HTTPS)

1. Install nginx and certbot, get a certificate for your domain.

2. Add a site config (`/etc/nginx/sites-available/openclaw-webui`):

```nginx
server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18890;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

3. Enable the site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/openclaw-webui /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Running as a systemd Service

```bash
sudo tee /etc/systemd/system/openclaw-webui.service > /dev/null <<EOF
[Unit]
Description=OpenClaw WebUI
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-webui
```

### Running with screen

```bash
screen -dmS openclaw-webui node server.js
# Reattach: screen -r openclaw-webui
```

---

## Development

```bash
# Auto-restart on file changes (Node.js 18+)
npm run dev
```

---

## License

[MIT](LICENSE) © 2026 OpenClaw WebUI Contributors
