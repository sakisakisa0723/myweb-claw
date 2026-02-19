# OpenClaw WebUI

A standalone Web chat interface that connects to [OpenClaw](https://github.com/openclaw/openclaw) Gateway via WebSocket. No framework, no build step — just Node.js + a single `server.js`.

**独立 Web 聊天界面**，通过 WebSocket 直连 [OpenClaw](https://github.com/openclaw/openclaw) Gateway。无需框架、无需构建步骤——只需 Node.js 和一个 `server.js` 文件。

<!-- Screenshot placeholder -->
<!-- ![OpenClaw WebUI Screenshot](docs/screenshot.png) -->

---

## Features / 功能特性

- 🔌 **WebSocket-native / 原生 WebSocket** — streams responses in real-time directly from OpenClaw Gateway / 从 OpenClaw Gateway 实时流式接收响应
- 🤖 **Multi-model / 多模型** — switch between Claude, Gemini, Grok, Kimi, and more on the fly / 随时切换 Claude、Gemini、Grok、Kimi 等多种模型
- 🌐 **Multi-Gateway / 多网关** — configure multiple OpenClaw Gateway connections, switch with one click / 配置多个 OpenClaw Gateway，一键切换
- 🔒 **Optional UI password / 可选界面密码** — protect the interface with a simple password gate / 用简单密码保护界面
- 📝 **Markdown rendering / Markdown 渲染** — code blocks, tables, and inline formatting with syntax highlighting / 代码块、表格、行内格式，支持语法高亮
- 🖼️ **Image upload / 图片上传** — paste or drag-and-drop images into the chat / 粘贴或拖拽图片到聊天框
- 📋 **Conversation history / 对话历史** — persistent session history in the browser / 浏览器端持久化会话历史
- 🚀 **Zero-dependency frontend / 零依赖前端** — pure vanilla JS, no React, no bundler / 纯原生 JS，无 React、无打包工具
- 🐳 **Lightweight / 轻量** — single Node.js process, ~1 npm dependency (`ws`) / 单 Node.js 进程，仅约 1 个 npm 依赖（`ws`）

---

## Quick Install / 快速安装

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-webui/main/install.sh)
```

This interactive script will:  
这个交互式脚本会：
1. Check for Node.js ≥ 18 / 检查 Node.js 版本 ≥ 18
2. Clone the repository / 克隆仓库
3. Walk you through Gateway configuration / 引导你配置 Gateway
4. Set up a systemd service or screen session / 设置 systemd 服务或 screen 会话

---

## Manual Install / 手动安装

```bash
# 1. Clone the repo / 克隆仓库
git clone https://github.com/openclaw/openclaw-webui.git
cd openclaw-webui

# 2. Install dependencies / 安装依赖
npm install

# 3. Create your config (see Configuration section below) / 创建配置（见下文配置部分）
cp config.example.json config.json
nano config.json

# 4. Start the server / 启动服务
node server.js
```

Open your browser at `http://localhost:18890`.  
打开浏览器访问 `http://localhost:18890`。

---

## Configuration / 配置

Edit `config.json` (see `config.example.json` for a template):  
编辑 `config.json`（参考 `config.example.json` 模板）：

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

| Field / 字段 | Description / 说明 |
|---|---|
| `gateways[].name` | Display name shown in the UI switcher / 界面选择器中显示的名称 |
| `gateways[].url` | WebSocket URL of your OpenClaw Gateway / OpenClaw Gateway 的 WebSocket URL |
| `gateways[].token` | Gateway authentication token / Gateway 认证令牌 |
| `gateways[].agentId` | Agent ID to connect to (usually `"main"`) / 要连接的 Agent ID（通常是 `"main"`） |
| `port` | HTTP port for the WebUI (default: `18890`) / WebUI 的 HTTP 端口（默认 `18890`） |
| `password` | Optional UI password. Leave empty to disable. / 可选的界面密码，留空则禁用 |
| `models` | List of models available in the model selector / 模型选择器中可用的模型列表 |

> **Note / 注意:** `config.json` is in `.gitignore` because it contains your token. Use `config.example.json` as the template and never commit your real config.  
> `config.json` 在 `.gitignore` 中，因为它包含你的令牌。使用 `config.example.json` 作为模板，切勿提交真实配置。

---

## Multiple Gateways / 多网关配置

You can configure multiple gateways and switch between them in the UI:  
你可以配置多个网关并在界面中切换：

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
    }
  ]
}
```

A gateway selector will appear in the UI when more than one gateway is configured.  
配置多于一个网关时，界面会显示网关选择器。

---

## Deployment / 部署

### Behind Nginx (Recommended for HTTPS) / Nginx 反向代理（推荐用于 HTTPS）

1. Install nginx and certbot, get a certificate for your domain.  
   安装 nginx 和 certbot，为你的域名获取证书。

2. Add a site config (`/etc/nginx/sites-available/openclaw-webui`):  
   添加站点配置（`/etc/nginx/sites-available/openclaw-webui`）：

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
   启用站点并重新加载：

```bash
sudo ln -s /etc/nginx/sites-available/openclaw-webui /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Running as a systemd Service / 以 systemd 服务运行

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

### Running with screen / 使用 screen 运行

```bash
screen -dmS openclaw-webui node server.js
# Reattach: screen -r openclaw-webui / 重新连接：screen -r openclaw-webui
```

---

## Development / 开发

```bash
# Auto-restart on file changes (Node.js 18+) / 文件变更时自动重启
npm run dev
```

---

## License / 许可证

[MIT](LICENSE) © 2026 OpenClaw WebUI Contributors
