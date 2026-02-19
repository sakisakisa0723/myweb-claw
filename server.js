'use strict';
/**
 * OpenClaw WebUI Server
 *
 * 架构:
 *   Browser <-> (HTTP/WS) <-> This Node.js server <-> (WS/JSON-RPC) <-> OpenClaw Gateway
 *
 * 依赖: ws (npm install ws)
 * 启动: node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ─────────────────────────────────────────────
// 1. 配置加载
// ─────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Failed to read config.json:', e.message);
  process.exit(1);
}

const PORT = config.port || 18890;
const GATEWAYS = config.gateways || [];
const PASSWORD = (config.password && config.password.trim()) ? config.password.trim() : null;
const AUTH_REQUIRED = !!PASSWORD;

// 手动配置的可用模型列表（从 config.json 读取，或使用默认值）
const CONFIG_MODELS = Array.isArray(config.models) && config.models.length > 0
  ? config.models
  : [
      { value: 'opus46',  label: 'Claude Opus 4.6' },
      { value: 'sonnet',  label: 'Claude Sonnet 4.6' },
      { value: 'gemini',  label: 'Gemini 2.5 Flash' },
      { value: 'pro',     label: 'Gemini 2.5 Pro' },
      { value: 'kimi',    label: 'Kimi' },
    ];

// ─────────────────────────────────────────────
// 1b. Device Identity (Ed25519 签名认证)
// ─────────────────────────────────────────────
const DEVICE_IDENTITY_PATH = path.join(__dirname, 'device.json');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function loadOrCreateDeviceIdentity() {
  try {
    if (fs.existsSync(DEVICE_IDENTITY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DEVICE_IDENTITY_PATH, 'utf8'));
      if (parsed?.version === 1 && parsed.publicKeyPem && parsed.privateKeyPem) {
        return { deviceId: parsed.deviceId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
      }
    }
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  const stored = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
  fs.writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  console.log('[Device] Generated new identity:', deviceId);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function buildDeviceAuthField(identity, token, nonce) {
  const clientId = 'gateway-client';
  const clientMode = 'backend';
  const role = 'operator';
  const scopes = 'operator.admin';
  const signedAtMs = Date.now();
  const version = nonce ? 'v2' : 'v1';
  const parts = [version, identity.deviceId, clientId, clientMode, role, scopes, String(signedAtMs), token || ''];
  if (nonce) parts.push(nonce);
  const payload = parts.join('|');
  const key = crypto.createPrivateKey(identity.privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  const field = {
    id: identity.deviceId,
    publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
    signature: base64UrlEncode(sig),
    signedAt: signedAtMs,
  };
  if (nonce) field.nonce = nonce;
  return field;
}

const deviceIdentity = loadOrCreateDeviceIdentity();
console.log('[Device] Identity:', deviceIdentity.deviceId);

// ─────────────────────────────────────────────
// 2. 内嵌 HTML 页面（完整前端）
//    用函数返回，避免模板字符串嵌套冲突
// ─────────────────────────────────────────────
function getHtmlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>OpenClaw WebUI</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljs-theme" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"><\/script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
  <style>
    /* ── CSS 变量（主题） ── */
    :root {
      --bg: #EDEDED;
      --bg2: #f7f7f7;
      --bg3: #e0e0e0;
      --chat-bg: #EDEDED;
      --sidebar-bg: #f5f5f5;
      --topbar-bg: #EDEDED;
      --border: #d9d9d9;
      --text: #1a1a1a;
      --text2: #555555;
      --text3: #888888;
      --user-bubble: #95EC69;
      --user-text: #1a1a1a;
      --assistant-bg: #ffffff;
      --tool-bg: #f2f2f2;
      --tool-border: #d0d0d0;
      --thinking-bg: #f5f0e8;
      --thinking-border: #d4b896;
      --accent: #07C160;
      --accent-hover: #06ad56;
      --danger: #e84040;
      --sidebar-w: 280px;
      --radius: 8px;
      --avatar-size: 40px;
    }
    [data-theme="dark"] {
      --bg: #1E1E1E;
      --bg2: #2a2a2a;
      --bg3: #333333;
      --chat-bg: #1E1E1E;
      --sidebar-bg: #252525;
      --topbar-bg: #252525;
      --border: #3a3a3a;
      --text: #e8e8e8;
      --text2: #aaaaaa;
      --text3: #666666;
      --user-bubble: #3d9a40;
      --user-text: #ffffff;
      --assistant-bg: #2d2d2d;
      --tool-bg: #252525;
      --tool-border: #3a3a3a;
      --thinking-bg: #2a2618;
      --thinking-border: #5a4a20;
      --accent: #07C160;
      --accent-hover: #06ad56;
    }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      transition: background 0.2s, color 0.2s;
    }

    /* ── 侧边栏（微信联系人列表风格） ── */
    #sidebar {
      width: var(--sidebar-w);
      min-width: var(--sidebar-w);
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      transition: transform 0.25s ease;
      z-index: 100;
    }
    #sidebar-header {
      padding: 0 14px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--topbar-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #sidebar-header h2 {
      font-size: 17px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: 0.2px;
    }
    #btn-new-session {
      width: 32px;
      height: 32px;
      background: transparent;
      color: var(--text2);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      padding: 4px;
    }
    #btn-new-session:hover { background: var(--bg3); }
    #btn-new-session svg { width: 20px; height: 20px; stroke: var(--text2); }

    #session-list {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }
    .session-item {
      display: flex;
      align-items: center;
      padding: 10px 14px;
      cursor: pointer;
      gap: 12px;
      transition: background 0.1s;
      border-bottom: 1px solid rgba(0,0,0,0.05);
      position: relative;
    }
    [data-theme="dark"] .session-item { border-bottom-color: rgba(255,255,255,0.05); }
    .session-item:hover { background: var(--bg3); }
    .session-item.active { background: #d6d6d6; }
    [data-theme="dark"] .session-item.active { background: #3a3a3a; }
    .session-avatar {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      background: #5B9CF6;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .session-avatar svg { width: 26px; height: 26px; }
    .session-info {
      flex: 1;
      overflow: hidden;
      min-width: 0;
    }
    .session-title {
      font-size: 15px;
      font-weight: 500;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-bottom: 3px;
    }
    .session-subtitle {
      font-size: 12px;
      color: var(--text3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-del-session {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text3);
      padding: 4px;
      opacity: 0;
      transition: opacity 0.15s;
      display: flex;
      align-items: center;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .btn-del-session svg { width: 15px; height: 15px; stroke: currentColor; }
    .session-item:hover .btn-del-session { opacity: 1; }
    .session-item:hover .btn-del-session:hover { color: var(--danger); background: rgba(232,64,64,0.1); }

    /* ── 主区域 ── */
    #main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--chat-bg);
    }

    /* ── 顶栏（微信风格导航栏） ── */
    #topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      height: 56px;
      background: var(--topbar-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #topbar-title {
      flex: 1;
      min-width: 0;
      text-align: center;
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #btn-sidebar-toggle {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text2);
      padding: 6px;
      border-radius: 6px;
      align-items: center;
      justify-content: center;
    }
    #btn-sidebar-toggle svg { width: 22px; height: 22px; }
    #btn-sidebar-toggle:hover { background: var(--bg3); }

    select {
      background: var(--bg2);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 7px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      outline: none;
    }
    select:focus { border-color: var(--accent); }

    /* ── 自定义模型选择器 ── */
    #model-picker {
      position: relative;
      display: inline-block;
    }
    #model-display {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
      color: var(--text);
      user-select: none;
      white-space: nowrap;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #model-display:hover, #model-display:focus {
      border-color: var(--accent);
      outline: none;
    }
    .model-arrow { font-size: 10px; color: var(--text3); margin-left: auto; }
    #model-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 1000;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      min-width: 180px;
      padding: 6px 0;
    }
    .model-dropdown-hidden { display: none !important; }
    #model-search {
      display: block;
      width: calc(100% - 16px);
      margin: 4px 8px 6px;
      padding: 5px 8px;
      font-size: 12px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      outline: none;
      box-sizing: border-box;
    }
    #model-search:focus { border-color: var(--accent); }
    #model-options { max-height: 220px; overflow-y: auto; }
    .model-option {
      padding: 7px 14px;
      font-size: 13px;
      cursor: pointer;
      color: var(--text);
      white-space: nowrap;
    }
    .model-option:hover { background: var(--bg3); }
    .model-option.selected { color: var(--accent); font-weight: 600; }
    .model-option.hidden { display: none; }

    /* ── 状态指示 ── */
    #sel-gateway {
      display: none;
    }
    #topbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    #status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #aaa;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    #status-dot.connected { background: #07C160; }
    #status-dot.connecting { background: #f0ad4e; animation: pulse 1s infinite; }
    #status-dot.error { background: #e84040; }
    @keyframes pulse {
      0%,100% { opacity: 1; } 50% { opacity: 0.4; }
    }
    #status-text {
      display: none;
    }

    #btn-theme {
      background: none;
      border: none;
      color: var(--text2);
      border-radius: 6px;
      width: 32px;
      height: 32px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      padding: 4px;
      flex-shrink: 0;
    }
    #btn-theme:hover { background: var(--bg3); }
    #btn-theme svg { width: 20px; height: 20px; }

    /* ── 消息区（微信聊天背景） ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      scroll-behavior: smooth;
      background: var(--chat-bg);
    }

    /* ── 消息行（含头像+气泡） ── */
    .msg-row {
      display: flex;
      width: 100%;
      align-items: flex-start;
      gap: 10px;
      padding: 2px 4px;
      animation: msgSlideIn 0.2s ease-out;
    }
    @keyframes msgSlideIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .msg-row.user {
      flex-direction: row-reverse;
      justify-content: flex-end;
    }
    .msg-row.assistant {
      flex-direction: row;
      justify-content: flex-start;
    }

    /* ── 头像（已隐藏） ── */
    .msg-avatar {
      display: none;
    }

    /* ── 气泡容器（含三角+气泡） ── */
    .bubble-wrap {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      max-width: 75%;
    }
    .msg-row.user .bubble-wrap {
      align-items: flex-end;
    }
    .bubble-with-arrow {
      display: flex;
      align-items: flex-start;
    }
    .msg-row.user .bubble-with-arrow {
      flex-direction: row-reverse;
    }

    /* ── 三角箭头（已隐藏，去掉头像后三角不再需要） ── */
    .bubble-arrow {
      display: none;
    }

    /* ── 气泡主体 ── */
    .bubble {
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: 15px;
      line-height: 1.6;
      word-break: break-word;
      max-width: 100%;
      position: relative;
      min-width: 10px;
    }
    .msg-row.user .bubble {
      background: var(--user-bubble);
      color: var(--user-text);
      border-top-right-radius: 2px;
    }
    .msg-row.assistant .bubble {
      background: var(--assistant-bg);
      color: var(--text);
      border-top-left-radius: 2px;
    }

    /* ── Markdown 渲染样式 ── */
    .bubble pre {
      background: #1a1d27;
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .bubble code:not(pre code) {
      background: rgba(0,0,0,0.10);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 0.88em;
    }
    .msg-row.user .bubble code:not(pre code) {
      background: rgba(0,0,0,0.15);
    }
    [data-theme="dark"] .bubble code:not(pre code) {
      background: rgba(255,255,255,0.1);
    }
    .bubble p { margin: 4px 0; }
    .bubble ul, .bubble ol { margin: 4px 0 4px 20px; }
    .bubble table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    .bubble th, .bubble td {
      border: 1px solid var(--border);
      padding: 5px 10px;
      font-size: 13px;
    }
    .bubble th { background: var(--bg3); }
    .bubble blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 10px;
      color: var(--text2);
      margin: 6px 0;
    }
    .bubble h1,.bubble h2,.bubble h3 { margin: 8px 0 4px; }

    /* ── 光标动画 ── */
    .cursor {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--text2);
      vertical-align: text-bottom;
      margin-left: 2px;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* ── 思考/工具折叠块 ── */
    .collapsible {
      margin: 4px 0;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--tool-border);
      width: 100%;
      font-size: 13px;
    }
    .collapsible.thinking { border-color: var(--thinking-border); }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      background: var(--tool-bg);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text2);
      user-select: none;
    }
    .collapsible.thinking .collapsible-header {
      background: var(--thinking-bg);
      color: #7a5c10;
    }
    [data-theme="dark"] .collapsible.thinking .collapsible-header { color: #c9a820; }
    .collapsible-header-icon { width: 14px; height: 14px; flex-shrink: 0; }
    .collapsible-arrow {
      display: flex;
      align-items: center;
      margin-left: auto;
      transition: transform 0.2s;
      flex-shrink: 0;
      color: var(--text3);
    }
    .collapsible-arrow svg { width: 12px; height: 12px; }
    .collapsible.open .collapsible-arrow { transform: rotate(90deg); }
    .collapsible-body {
      display: none;
      padding: 8px 10px;
      background: var(--tool-bg);
      font-size: 12px;
      color: var(--text2);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }
    .collapsible.thinking .collapsible-body {
      background: var(--thinking-bg);
      font-style: italic;
      color: #5a4010;
    }
    [data-theme="dark"] .collapsible.thinking .collapsible-body { color: #c9a820; }
    .collapsible.open .collapsible-body { display: block; }

    /* ── 输入区（微信风格） ── */
    #input-area {
      border-top: 1px solid var(--border);
      padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom));
      background: var(--topbar-bg);
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    #input-wrap {
      flex: 1;
      display: flex;
      align-items: flex-end;
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      transition: border-color 0.2s;
    }
    [data-theme="dark"] #input-wrap {
      background: var(--bg2);
    }
    #input-wrap:focus-within { border-color: var(--accent); }
    #input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 15px;
      line-height: 1.5;
      resize: none;
      max-height: 200px;
      overflow-y: auto;
      padding: 0;
      font-family: inherit;
    }
    #input::placeholder { color: var(--text3); }
    #btn-send {
      background: var(--accent);
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s, transform 0.1s;
    }
    #btn-send:hover { background: var(--accent-hover); }
    #btn-send:active { transform: scale(0.93); }
    #btn-send svg { width: 20px; height: 20px; fill: #fff; }
    #btn-send.cancel { background: var(--danger); }

    /* ── 空状态 ── */
    #empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      color: var(--text3);
    }
    #empty-state .logo {
      width: 72px;
      height: 72px;
      opacity: 0.5;
    }
    #empty-state p { font-size: 15px; }

    /* ── 手机端适配 ── */
    @media (max-width: 640px) {
      #sidebar {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        transform: translateX(-100%);
      }
      #sidebar.open { transform: translateX(0); box-shadow: 4px 0 20px rgba(0,0,0,0.2); }
      #btn-sidebar-toggle { display: flex; }
      #overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.4);
        z-index: 99;
      }
      #overlay.show { display: block; }
      .bubble-wrap { max-width: 85%; }
    }

    /* ── 滚动条 ── */
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }


    /* ── 密码保护界面 ── */
    #auth-screen {
      display: none;
      position: fixed;
      inset: 0;
      background: var(--bg);
      z-index: 9999;
      align-items: center;
      justify-content: center;
    }
    #auth-screen.show { display: flex; }
    #auth-card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 36px;
      width: 360px;
      max-width: 90vw;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.3);
    }
    #auth-logo {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #auth-logo svg { width: 64px; height: 64px; }
    #auth-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text);
      text-align: center;
    }
    #auth-subtitle {
      font-size: 13px;
      color: var(--text3);
      text-align: center;
      margin-top: -12px;
    }
    #auth-input {
      width: 100%;
      padding: 11px 14px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
      font-family: inherit;
    }
    #auth-input:focus { border-color: var(--accent); }
    #auth-btn {
      width: 100%;
      padding: 11px 0;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    #auth-btn:hover { opacity: 0.85; }
    #auth-error {
      font-size: 13px;
      color: var(--danger);
      text-align: center;
      min-height: 18px;
    }

    /* ── 侧边栏底部 ── */
    #sidebar-footer {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    #btn-clear-sessions {
      width: 100%;
      padding: 8px 0;
      background: none;
      border: 1px solid var(--border);
      color: var(--text3);
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #btn-clear-sessions:hover {
      background: rgba(232,64,64,0.1);
      color: var(--danger);
      border-color: var(--danger);
    }

    /* ── 附件预览条 ── */
    #attachment-preview {
      display: none;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 16px 4px;
      background: var(--bg);
      border-top: 1px solid var(--border);
    }
    #attachment-preview.has-items { display: flex; }
    .att-item {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      min-width: 80px;
      max-width: 100px;
    }
    .att-thumb {
      width: 72px;
      height: 72px;
      object-fit: cover;
      border-radius: 5px;
      display: block;
    }
    .att-icon {
      width: 72px;
      height: 72px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      color: var(--text3);
      background: var(--bg3);
      border-radius: 5px;
    }
    .att-name {
      font-size: 10px;
      color: var(--text2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 88px;
      text-align: center;
    }
    .att-remove {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--danger);
      color: #fff;
      border: none;
      cursor: pointer;
      font-size: 11px;
      line-height: 18px;
      text-align: center;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .att-remove:hover { opacity: 0.8; }

    /* ── 附件按钮 ── */
    #btn-attach {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text3);
      padding: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #btn-attach:hover { color: var(--accent); background: var(--bg3); }

    /* ── 断连横幅 ── */
    #disconnect-banner {
      display: none;
      position: sticky;
      top: 0;
      z-index: 200;
      background: #e84040;
      color: #fff;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      padding: 7px 16px;
      letter-spacing: 0.2px;
    }
    #disconnect-banner.show { display: block; }

    /* ── 拖拽遮罩 ── */
    #drag-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(7, 193, 96, 0.12);
      border: 3px dashed var(--accent);
      z-index: 9999;
      pointer-events: none;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: 700;
      color: var(--accent);
      gap: 12px;
      flex-direction: column;
    }
    #drag-overlay.show {
      display: flex;
      pointer-events: all;
    }

    /* ── 用户气泡图片 ── */
    .bubble-img {
      max-width: 240px;
      max-height: 200px;
      border-radius: 8px;
      margin-top: 6px;
      display: block;
      object-fit: contain;
    }
    .bubble-file {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 12px;
      background: rgba(0,0,0,0.08);
      border-radius: 6px;
      padding: 5px 8px;
    }
  </style>
</head>
<body data-theme="dark">

<!-- 密码验证界面 -->
<div id="auth-screen">
  <div id="auth-card">
    <div id="auth-logo">
      <svg viewBox="0 0 48 48" fill="none" stroke="#07C160" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="24" cy="24" r="20"/>
        <path d="M16 20 C16 14 32 14 32 20 C32 26 24 26 24 30"/>
        <circle cx="24" cy="36" r="1.5" fill="#07C160"/>
      </svg>
    </div>
    <div id="auth-title">OpenClaw WebUI</div>
    <div id="auth-subtitle">请输入访问密码</div>
    <input type="password" id="auth-input" placeholder="密码" autocomplete="current-password" />
    <button id="auth-btn">确认</button>
    <div id="auth-error"></div>
  </div>
</div>

<!-- 遮罩（手机端侧边栏关闭） -->
<div id="overlay"></div>

<!-- 拖拽上传遮罩 -->
<div id="drag-overlay">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:48px;height:48px">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
  <div>松开鼠标以上传文件</div>
</div>

<!-- 隐藏的文件选择器 -->
<input type="file" id="file-input" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/javascript,text/typescript,text/css,application/json" style="display:none" />

<!-- ── 侧边栏 ── -->
<aside id="sidebar">
  <div id="sidebar-header">
    <h2>OpenClaw</h2>
    <button id="btn-new-session" title="新建会话">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </button>
  </div>
  <div id="session-list"></div>
  <div id="sidebar-footer">
    <button id="btn-clear-sessions">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
      </svg>
      清空所有会话
    </button>
  </div>
</aside>

<!-- ── 主区域 ── -->
<div id="main">
  <!-- 顶栏（微信风格） -->
  <div id="topbar">
    <button id="btn-sidebar-toggle" title="菜单">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <span id="topbar-title">选择或新建会话</span>
    <select id="sel-gateway" title="选择 Gateway"></select>
    <div id="topbar-right">
      <div id="model-picker" title="切换模型">
        <div id="model-display" tabindex="0">
          <span id="model-label">加载中…</span>
          <span class="model-arrow">▾</span>
        </div>
        <div id="model-dropdown" class="model-dropdown-hidden">
          <input id="model-search" type="text" placeholder="搜索模型…" autocomplete="off" />
          <div id="model-options"></div>
        </div>
      </div>
      <span id="status-dot" title="连接状态"></span>
      <button id="btn-theme" title="切换主题">
      <svg id="icon-theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
      <svg id="icon-theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    </button>
    </div>
  </div>

  <!-- 断连横幅 -->
  <div id="disconnect-banner">连接已断开，正在重连...</div>

  <!-- 消息区 -->
  <div id="messages">
    <div id="empty-state">
      <div class="logo">
        <svg viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="14" y="20" width="44" height="36" rx="6"/>
          <circle cx="26" cy="38" r="4"/>
          <circle cx="46" cy="38" r="4"/>
          <path d="M28 50 C28 54 44 54 44 50"/>
          <path d="M24 20 L24 14 M48 20 L48 14"/>
          <rect x="20" y="10" width="8" height="8" rx="2"/>
          <rect x="44" y="10" width="8" height="8" rx="2"/>
        </svg>
      </div>
      <p>选择或新建一个会话，开始对话</p>
    </div>
  </div>

  <!-- 附件预览条 -->
  <div id="attachment-preview"></div>

  <!-- 输入区（微信风格） -->
  <div id="input-area">
    <button id="btn-attach" title="添加附件">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
      </svg>
    </button>
    <div id="input-wrap">
      <textarea id="input" rows="1" placeholder="输入消息..."></textarea>
    </div>
    <button id="btn-send" title="发送">
      <svg viewBox="0 0 24 24" fill="white">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
      </svg>
    </button>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════
//  OpenClaw WebUI — 前端逻辑 (原生 JS，无框架)
// ═══════════════════════════════════════════════════════

/* ─── 全局状态 ─────────────────────────────────────── */
const state = {
  sessions: [],          // { id, title, gatewayIdx, sessionKey, messages[] }
  currentSessionId: null,
  gateways: [],          // 从后端 init 消息获取
  ws: null,              // 到后端的 WebSocket
  wsConnected: false,
  pendingMessages: [],   // 断线时的待发消息队列 [{ obj, msgEl }]
  currentModel: 'claude-opus-4-6',
  currentRunId: null,
  isStreaming: false,
  theme: 'dark',
  attachments: [],       // 当前待发附件 [File]
  authenticated: false,  // 是否已通过密码验证
};

// ─── 可用模型列表（从后端 init 消息获取，格式 {value, label}）────
let availableModels = [];

/* ─── DOM 引用 ─────────────────────────────────────── */
const byId = id => document.getElementById(id);
const dom = {
  sidebar:           byId('sidebar'),
  overlay:           byId('overlay'),
  sessionList:       byId('session-list'),
  messages:          byId('messages'),
  emptyState:        byId('empty-state'),
  input:             byId('input'),
  btnSend:           byId('btn-send'),
  btnNewSession:     byId('btn-new-session'),
  btnSidebarToggle:  byId('btn-sidebar-toggle'),
  btnTheme:          byId('btn-theme'),
  selGateway:        byId('sel-gateway'),
  modelPicker:       byId('model-picker'),
  modelDisplay:      byId('model-display'),
  modelLabel:        byId('model-label'),
  modelDropdown:     byId('model-dropdown'),
  modelSearch:       byId('model-search'),
  modelOptions:      byId('model-options'),
  statusDot:         byId('status-dot'),
  statusText:        byId('status-text'),
  btnAttach:         byId('btn-attach'),
  fileInput:         byId('file-input'),
  attPreview:        byId('attachment-preview'),
  dragOverlay:       byId('drag-overlay'),
  authScreen:        byId('auth-screen'),
  authInput:         byId('auth-input'),
  authBtn:           byId('auth-btn'),
  authError:         byId('auth-error'),
  btnClearSessions:  byId('btn-clear-sessions'),
  disconnectBanner:  byId('disconnect-banner'),
};

/* ─── 工具函数 ─────────────────────────────────────── */
const genId = () => 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 自适应 textarea 高度 */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

/** 平滑滚动到底部 */
function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

/** Markdown 渲染（含代码高亮） */
function renderMarkdown(raw) {
  if (!raw) return '';
  if (typeof marked === 'undefined') return '<p>' + escapeHtml(raw) + '</p>';

  const renderer = new marked.Renderer();
  renderer.code = function(token) {
    // marked v9 passes token object
    const codeStr = typeof token === 'object' ? (token.text || '') : token;
    const langStr = typeof token === 'object' ? (token.lang || '') : '';
    if (langStr && typeof hljs !== 'undefined' && hljs.getLanguage(langStr)) {
      try {
        const highlighted = hljs.highlight(codeStr, { language: langStr }).value;
        return '<pre><code class="hljs language-' + escapeHtml(langStr) + '">' + highlighted + '</code></pre>';
      } catch (e) { /* fall through */ }
    }
    const escaped = typeof hljs !== 'undefined' ? hljs.highlightAuto(codeStr).value : escapeHtml(codeStr);
    return '<pre><code class="hljs">' + escaped + '</code></pre>';
  };

  marked.use({ renderer, breaks: true, gfm: true });
  return marked.parse(raw);
}

/* ─── 附件处理 ──────────────────────────────────────── */
const ALLOWED_MIME = new Set([
  'image/png','image/jpeg','image/gif','image/webp',
  'application/pdf','text/plain','text/markdown',
  'text/javascript','text/typescript','text/css','application/json',
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ATTACHMENTS = 5;

function addFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      alert('最多只能添加 ' + MAX_ATTACHMENTS + ' 个附件');
      break;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(file.name + ' 超过 10MB 限制，已跳过');
      continue;
    }
    if (!ALLOWED_MIME.has(file.type)) {
      // 仍然允许，但给提示
      console.warn('不支持的文件类型:', file.type, '- 仍然添加');
    }
    // 避免重复
    const alreadyAdded = state.attachments.some(f => f.name === file.name && f.size === file.size && f.type === file.type);
    if (alreadyAdded) continue;
    state.attachments.push(file);
  }
  renderAttachmentPreview();
}

function removeAttachment(idx) {
  state.attachments.splice(idx, 1);
  renderAttachmentPreview();
}

function clearAttachments() {
  state.attachments = [];
  dom.fileInput.value = '';
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  dom.attPreview.innerHTML = '';
  if (state.attachments.length === 0) {
    dom.attPreview.classList.remove('has-items');
    return;
  }
  dom.attPreview.classList.add('has-items');
  state.attachments.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'att-item';

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      const img = document.createElement('img');
      img.className = 'att-thumb';
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      item.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'att-icon';
      icon.innerHTML = file.type === 'application/pdf'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
      item.appendChild(icon);
    }

    const name = document.createElement('div');
    name.className = 'att-name';
    name.textContent = file.name;
    name.title = file.name + ' (' + (file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1)+'MB' : (file.size/1024).toFixed(0)+'KB') + ')';
    item.appendChild(name);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'att-remove';
    rmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    rmBtn.title = '移除';
    rmBtn.addEventListener('click', () => removeAttachment(idx));
    item.appendChild(rmBtn);

    dom.attPreview.appendChild(item);
  });
}

/** 将 File 转为 base64（不含 data: 前缀） */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target.result; // data:mime;base64,xxxx
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 将指定文件数组转为 attachments 数组（async） */
async function buildAttachmentsFromFiles(files) {
  const result = [];
  for (const file of files) {
    const data = await fileToBase64(file);
    result.push({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      data,
      size: file.size,
    });
  }
  return result;
}

/** 将当前所有附件转为 attachments 数组（async） */
async function buildAttachments() {
  return buildAttachmentsFromFiles(state.attachments);
}

// 📎 按钮点击 → 触发文件选择器
dom.btnAttach.addEventListener('click', () => {
  dom.fileInput.value = '';
  dom.fileInput.click();
});

// 文件选择器 change
dom.fileInput.addEventListener('change', () => {
  addFiles(Array.from(dom.fileInput.files));
});

// ─── 粘贴上传 ────────────────────────────────────────
dom.input.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        // 给个名字
        const ext = item.type.split('/')[1] || 'png';
        const named = new File([file], 'paste_' + Date.now() + '.' + ext, { type: item.type });
        imageFiles.push(named);
      }
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault();
    addFiles(imageFiles);
  }
});

// ─── 拖拽上传 ────────────────────────────────────────
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
    dragCounter++;
    dom.dragOverlay.classList.add('show');
  }
});

document.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dom.dragOverlay.classList.remove('show');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dom.dragOverlay.classList.remove('show');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    addFiles(Array.from(e.dataTransfer.files));
  }
});

/* ─── 主题 ─────────────────────────────────────────── */
function setTheme(t) {
  state.theme = t;
  document.body.dataset.theme = t;
  // Update theme icon
  const sunIcon = document.getElementById('icon-theme-sun');
  const moonIcon = document.getElementById('icon-theme-moon');
  if (sunIcon && moonIcon) {
    sunIcon.style.display = t === 'dark' ? 'block' : 'none';
    moonIcon.style.display = t === 'dark' ? 'none' : 'block';
  }
  const hl = document.getElementById('hljs-theme');
  hl.href = t === 'dark'
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  try { localStorage.setItem('oc-theme', t); } catch(e) {}
}

dom.btnTheme.addEventListener('click', () => {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
});

/* ─── 侧边栏（手机端折叠） ───────────────────────── */
function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.overlay.classList.add('show');
}
function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.overlay.classList.remove('show');
}
dom.btnSidebarToggle.addEventListener('click', () => {
  dom.sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
dom.overlay.addEventListener('click', closeSidebar);

/* ─── 连接状态显示 ─────────────────────────────────── */
function setStatus(cls, text) {
  dom.statusDot.className = cls; // 'connected' | 'connecting' | 'error' | ''
  const pending = state.pendingMessages.length;
  const tooltip = pending > 0 ? text + ' · ' + pending + ' 条消息待发送' : text;
  dom.statusDot.title = tooltip;
}

function refreshStatus() {
  if (!state.wsConnected) {
    const pending = state.pendingMessages.length;
    if (pending > 0) {
      setStatus('connecting', '重连中...');
    }
    return;
  }
  // 已连接时也刷新，以更新待发数量（此时应为0）
  const pending = state.pendingMessages.length;
  if (pending === 0) {
    setStatus('connected', '已连接');
  }
}

/* ─── 冲刷待发消息队列 ──────────────────────────── */
function flushPendingMessages() {
  const pending = state.pendingMessages.splice(0);
  pending.forEach(({ obj, msgEl }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
    if (msgEl) {
      msgEl.style.opacity = '';
      const label = msgEl.querySelector('.pending-label');
      if (label) label.remove();
    }
  });
}

/* ─── Bug 2 修复：禁用/恢复输入框和发送按钮 ──────── */
function setInputDisabled(disabled) {
  dom.input.disabled = disabled;
  dom.btnSend.disabled = disabled;
  dom.input.style.opacity = disabled ? '0.45' : '';
  dom.btnSend.style.opacity = disabled ? '0.45' : '';
  dom.input.style.cursor = disabled ? 'not-allowed' : '';
  dom.btnSend.style.cursor = disabled ? 'not-allowed' : '';
}

/**
 * Bug 2 修复：断连时，对所有正在流式输出（未 done）的 assistant 消息，
 * 在消息下方追加灰色提示"回复可能已中断，请重新发送"。
 */
function markInterruptedStreams() {
  // 找出当前 session 中所有未完成的 assistant 消息
  const sess = state.sessions.find(s => s.id === state.currentSessionId);
  if (!sess) return;
  sess.messages.forEach(m => {
    if (m.role === 'assistant' && !m.done) {
      // 标记为已完成（避免重复提示）
      m.done = true;
      // 更新气泡（去除光标）
      const row = dom.messages.querySelector('[data-msg-id="' + m.id + '"]');
      if (row) {
        const bub = row.querySelector('.bubble');
        if (bub) {
          bub.innerHTML = renderMarkdown(m.content);
          // 追加灰色提示
          const hint = document.createElement('div');
          hint.style.cssText = 'margin-top:8px;font-size:12px;color:#999;font-style:italic;';
          hint.textContent = '回复可能已中断，请重新发送';
          bub.appendChild(hint);
        }
      }
    }
  });
  // 重置流式状态
  state.isStreaming = false;
  state.currentRunId = null;
  updateSendBtn();
}

/* ─── WebSocket 连接（前端 → 后端） ──────────────── */
let wsReconnectTimer = null;

function connectWS() {
  // 避免重复建立连接（已有连接中的ws时跳过）
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  setStatus('connecting', '连接中...');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');
  state.ws = ws;

  ws.addEventListener('open', () => {
    console.log('[WS] open event fired');
    state.wsConnected = true;
    setStatus('connected', '已连接');
    // pending 消息在 auth_ok（有密码）或收到 init（无密码）后冲刷
    // 对于无密码的情况，等收到 init 消息后再标记 authenticated 并冲刷

    // Bug 2 修复：重连成功，隐藏断连横幅，恢复输入功能（等 init/auth_ok 后再恢复）
    setInputDisabled(false);
    dom.disconnectBanner.classList.remove('show');
  });

  ws.addEventListener('close', (evt) => {
    console.log('[WS] close event, code=' + evt.code + ' reason=' + evt.reason);
    state.wsConnected = false;
    state.ws = null;
    state.authenticated = false; // 断线后重置认证状态
    const pending = state.pendingMessages.length;
    setStatus('error', pending > 0 ? '连接断开，重连中...' : '连接断开，重连中...');

    // Bug 2 修复：断连时禁用输入框和发送按钮，显示断连横幅
    setInputDisabled(true);
    dom.disconnectBanner.classList.add('show');

    // Bug 2 修复：如果有正在进行的 AI 回复（lifecycle start 但未 end），显示中断提示
    markInterruptedStreams();

    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => {
    setStatus('error', '连接错误');
  });

  ws.addEventListener('message', evt => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch(e) { console.error('[WS] parse error', e); return; }
    console.log('[WS] recv:', msg.type);
    try {
      handleServerMsg(msg);
    } catch(err) {
      console.error('[WS] handleServerMsg error:', err);
    }
  });
}

/**
 * 向后端发送 JSON。
 * 如果 ws 未连接，将消息放入 pendingMessages 队列并触发重连。
 * @param {object} obj        - 要发送的消息对象
 * @param {HTMLElement} [msgEl] - 对应的用户气泡 DOM 元素（可选，用于半透明状态）
 */
function wsSend(obj, msgEl) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  } else {
    // 入队并触发重连
    state.pendingMessages.push({ obj, msgEl });
    if (msgEl) {
      // 半透明 + 发送中提示
      msgEl.style.opacity = '0.55';
      if (!msgEl.querySelector('.pending-label')) {
        const lbl = document.createElement('span');
        lbl.className = 'pending-label';
        lbl.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.75);margin-top:4px;display:block;text-align:right';
        lbl.textContent = '发送中...';
        msgEl.appendChild(lbl);
      }
    }
    setStatus('connecting', '重连中...');
    connectWS();
  }
}

/* ─── 处理后端消息 ─────────────────────────────────── */
function handleServerMsg(msg) {
  switch (msg.type) {

    case 'auth_required':
      showAuthScreen();
      break;

    case 'auth_ok':
      hideAuthScreen();
      state.authenticated = true;
      flushPendingMessages();
      break;

    case 'auth_fail':
      // 清除可能错误的保存密码
      try { localStorage.removeItem('oc-password'); } catch(e) {}
      dom.authScreen.classList.add('show');
      dom.authError.textContent = '密码错误，请重试';
      dom.authInput.value = '';
      setTimeout(() => dom.authInput.focus(), 100);
      break;

    case 'init':
      state.gateways = msg.gateways || [];
      buildGatewaySelect();
      // 从 init 消息获取模型列表并渲染
      if (Array.isArray(msg.models) && msg.models.length > 0) {
        availableModels = msg.models;
      }
      buildModelOptions(availableModels);
      // 无密码时，收到 init 就表示已认证，冲刷待发队列
      if (!state.authenticated) {
        state.authenticated = true;
        flushPendingMessages();
      }
      break;

    case 'status':
      if (state.gateways[msg.gateway] !== undefined) {
        state.gateways[msg.gateway].connected = msg.connected;
      }
      refreshGatewayStatus();
      break;

    case 'lifecycle': {
      const sess = findSess(msg.sessionKey, msg.gateway);
      if (!sess) break;

      if (msg.phase === 'start') {
        state.currentRunId = msg.runId;
        state.isStreaming = true;
        updateSendBtn();
        // 创建 AI 消息占位符
        const m = { id: 'msg_' + Date.now(), role: 'assistant',
                    content: '', thinking: '', tools: [], done: false };
        sess.messages.push(m);
        if (isCurrent(sess)) appendAssistantRow(m);
      } else {
        // end | error | cancelled
        state.isStreaming = false;
        state.currentRunId = null;
        updateSendBtn();
        finalizeLastMsg(sess);

        if (msg.phase === 'error') {
          addSysMsg(sess, '错误: ' + (msg.message || '未知错误'));
        } else if (msg.phase === 'cancelled') {
          addSysMsg(sess, '已取消');
        }
      }
      break;
    }

    case 'chunk': {
      const sess = findSess(msg.sessionKey, msg.gateway);
      if (!sess) break;
      const m = lastAsstMsg(sess);
      if (!m) break;
      m.content += msg.text;
      if (isCurrent(sess)) updateBubbleStream(m);
      updateSessTitle(sess);
      break;
    }

    case 'thinking': {
      const sess = findSess(msg.sessionKey, msg.gateway);
      if (!sess) break;
      const m = lastAsstMsg(sess);
      if (!m) break;
      m.thinking += msg.text;
      if (isCurrent(sess)) updateThinkingBlock(m);
      break;
    }

    case 'tool_start': {
      const sess = findSess(msg.sessionKey, msg.gateway);
      if (!sess) break;
      const m = lastAsstMsg(sess);
      if (!m) break;
      const tool = { id: 'tool_' + Date.now(), name: msg.name, args: msg.args, result: null };
      m.tools.push(tool);
      if (isCurrent(sess)) addToolBlock(m, tool);
      break;
    }

    case 'tool_result': {
      const sess = findSess(msg.sessionKey, msg.gateway);
      if (!sess) break;
      const m = lastAsstMsg(sess);
      if (!m) break;
      const tool = [...m.tools].reverse().find(t => t.name === msg.name && t.result === null);
      if (tool) {
        tool.result = msg.result;
        if (isCurrent(sess)) updateToolResult(m, tool);
      }
      break;
    }

    case 'error':
      setStatus('error', '错误: ' + msg.message);
      break;
  }
}

/* ─── Gateway 下拉框 ─────────────────────────────── */
function buildGatewaySelect() {
  dom.selGateway.innerHTML = '';
  state.gateways.forEach((gw, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = gw.name || ('Gateway ' + i);
    dom.selGateway.appendChild(opt);
  });
  refreshGatewayStatus();
}

function refreshGatewayStatus() {
  const idx = parseInt(dom.selGateway.value, 10) || 0;
  const gw = state.gateways[idx];
  if (!gw) return;
  if (gw.connected) {
    setStatus('connected', '已连接: ' + gw.name);
  } else {
    setStatus('connecting', '连接中: ' + gw.name);
  }
}

dom.selGateway.addEventListener('change', () => {
  refreshGatewayStatus();
});

/* ─── 自定义模型下拉框 ──────────────────────────── */
function renderModelOptions(filterText) {
  const q = (filterText || '').toLowerCase().trim();
  const items = dom.modelOptions.querySelectorAll('.model-option');
  items.forEach(el => {
    const match = !q || el.dataset.label.toLowerCase().includes(q);
    el.classList.toggle('hidden', !match);
  });
}

function selectModel(value, label) {
  state.currentModel = value;
  dom.modelLabel.textContent = label;
  // 更新 selected 样式
  dom.modelOptions.querySelectorAll('.model-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === value);
  });
  closeModelDropdown();
}

function openModelDropdown() {
  dom.modelDropdown.classList.remove('model-dropdown-hidden');
  dom.modelSearch.value = '';
  renderModelOptions('');
  setTimeout(() => dom.modelSearch.focus(), 50);
}

function closeModelDropdown() {
  dom.modelDropdown.classList.add('model-dropdown-hidden');
}

function buildModelOptions(models) {
  const prevValue = state.currentModel;
  dom.modelOptions.innerHTML = '';
  models.forEach(m => {
    const el = document.createElement('div');
    el.className = 'model-option';
    el.dataset.value = m.value;
    el.dataset.label = m.label;
    el.textContent = m.label;
    if (m.value === prevValue) el.classList.add('selected');
    el.addEventListener('click', () => {
      selectModel(m.value, m.label);
      // 发送切换模型命令
      const sess = state.sessions.find(s => s.id === state.currentSessionId);
      if (sess) {
        wsSend({
          type: 'send',
          gateway: sess.gatewayIdx,
          sessionKey: sess.sessionKey,
          message: '/model ' + state.currentModel,
        });
      }
    });
    dom.modelOptions.appendChild(el);
  });

  // 选中当前模型（或第一个）
  const found = models.find(m => m.value === prevValue);
  if (found) {
    dom.modelLabel.textContent = found.label;
  } else if (models.length > 0) {
    state.currentModel = models[0].value;
    dom.modelLabel.textContent = models[0].label;
    dom.modelOptions.querySelector('.model-option')?.classList.add('selected');
  }
}

// 事件绑定
dom.modelDisplay.addEventListener('click', () => {
  if (dom.modelDropdown.classList.contains('model-dropdown-hidden')) {
    openModelDropdown();
  } else {
    closeModelDropdown();
  }
});
dom.modelDisplay.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModelDropdown(); }
});
dom.modelSearch.addEventListener('input', () => renderModelOptions(dom.modelSearch.value));
dom.modelSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModelDropdown();
});
// 点击外部关闭
document.addEventListener('click', e => {
  if (!dom.modelPicker.contains(e.target)) closeModelDropdown();
});

function updateModelsForGateway(gwIdx) {
  // gwIdx 参数保留以兼容调用方，但模型列表现在来自 availableModels
  if (availableModels.length > 0) {
    buildModelOptions(availableModels);
  }
}

/* ─── 密码认证 UI ────────────────────────────── */
function showAuthScreen() {
  dom.authError.textContent = '';
  // 尝试从 localStorage 读取保存的密码并自动验证（静默）
  try {
    const saved = localStorage.getItem('oc-password');
    if (saved && state.ws && state.ws.readyState === WebSocket.OPEN) {
      // 先静默发送，不显示界面；如果失败再显示
      state.ws.send(JSON.stringify({ type: 'auth', password: saved }));
      return; // 等待 auth_ok 或 auth_fail 响应
    }
  } catch(e) {}
  // 没有保存的密码，显示界面
  dom.authScreen.classList.add('show');
  setTimeout(() => dom.authInput.focus(), 100);
}

function hideAuthScreen() {
  dom.authScreen.classList.remove('show');
}

function submitAuth() {
  const pwd = dom.authInput.value;
  if (!pwd) { dom.authError.textContent = '请输入密码'; return; }
  dom.authError.textContent = '';
  // 保存密码到 localStorage
  try { localStorage.setItem('oc-password', pwd); } catch(e) {}
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'auth', password: pwd }));
  }
}

dom.authBtn.addEventListener('click', submitAuth);
dom.authInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAuth();
});

/* ─── Session 持久化 ─────────────────────────── */
const OC_SESSIONS_KEY = 'oc-sessions';
const OC_CURRENT_KEY = 'oc-current-session';

/** 把 sessions 序列化为纯数据后存入 localStorage（节流：只在消息完成时调用） */
function persistSessions() {
  try {
    const data = state.sessions.map(sess => ({
      id: sess.id,
      title: sess.title,
      gatewayIdx: sess.gatewayIdx,
      sessionKey: sess.sessionKey,
      messages: sess.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content || '',
        thinking: m.thinking || '',
        tools: (m.tools || []).map(t => ({
          id: t.id,
          name: t.name,
          args: t.args,
          result: t.result,
        })),
        done: m.done !== false, // 持久化时标记为已完成
        // 附件：只存 mimeType 和 data（base64），不存 File 对象
        attachments: (m.attachments || []).map(att => ({
          filename: att.filename,
          mimeType: att.mimeType,
          data: att.data,
          size: att.size,
        })),
      })),
    }));
    localStorage.setItem(OC_SESSIONS_KEY, JSON.stringify(data));
    if (state.currentSessionId) {
      localStorage.setItem(OC_CURRENT_KEY, state.currentSessionId);
    }
  } catch(e) {
    console.warn('Failed to persist sessions:', e);
  }
}

/** 从 localStorage 恢复 sessions */
function restoreSessions() {
  try {
    const raw = localStorage.getItem(OC_SESSIONS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    state.sessions = data.map(sess => ({
      id: sess.id,
      title: sess.title || '新会话',
      gatewayIdx: sess.gatewayIdx || 0,
      sessionKey: sess.sessionKey,
      messages: (sess.messages || []).map(m => ({
        id: m.id || ('msg_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
        role: m.role,
        content: m.content || '',
        thinking: m.thinking || '',
        tools: m.tools || [],
        done: m.done !== false,
        attachments: m.attachments || [],
      })),
    }));
    const savedCurrent = localStorage.getItem(OC_CURRENT_KEY);
    if (savedCurrent && state.sessions.some(s => s.id === savedCurrent)) {
      state.currentSessionId = savedCurrent;
    } else if (state.sessions.length > 0) {
      state.currentSessionId = state.sessions[state.sessions.length - 1].id;
    }
  } catch(e) {
    console.warn('Failed to restore sessions:', e);
  }
}

/** 清空所有会话 */
function clearAllSessions() {
  if (!confirm('确定清空所有会话记录？此操作不可撤销。')) return;
  state.sessions = [];
  state.currentSessionId = null;
  try {
    localStorage.removeItem(OC_SESSIONS_KEY);
    localStorage.removeItem(OC_CURRENT_KEY);
  } catch(e) {}
  dom.messages.innerHTML = '';
  dom.messages.appendChild(dom.emptyState);
  renderSessList();
}

dom.btnClearSessions.addEventListener('click', clearAllSessions);

/* ─── Session 管理 ──────────────────────────────── */
function createSession() {
  const gwIdx = parseInt(dom.selGateway.value, 10) || 0;
  const id = genId();
  const sess = {
    id,
    title: '新会话',
    gatewayIdx: gwIdx,
    sessionKey: 'webui:' + id,
    messages: [],
  };
  state.sessions.push(sess);
  renderSessList();
  switchSession(id);
  // 新建会话时更新顶部标题
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = '新会话';
  persistSessions();
  return sess;
}

function deleteSession(id) {
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  state.sessions.splice(idx, 1);
  if (state.currentSessionId === id) {
    state.currentSessionId = null;
    dom.messages.innerHTML = '';
    dom.messages.appendChild(dom.emptyState);
  }
  renderSessList();
  persistSessions();
}

function switchSession(id) {
  state.currentSessionId = id;
  renderSessList();
  const sess = state.sessions.find(s => s.id === id);
  if (!sess) return;
  dom.selGateway.value = sess.gatewayIdx;
  renderMessages(sess);
  closeSidebar();
  // 更新顶部标题
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = sess.title || '新会话';
  try { localStorage.setItem(OC_CURRENT_KEY, id); } catch(e) {}
}

function findSess(sessionKey, gwIdx) {
  return state.sessions.find(s => s.sessionKey === sessionKey && s.gatewayIdx === gwIdx);
}

function isCurrent(sess) { return state.currentSessionId === sess.id; }

function lastAsstMsg(sess) {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    if (sess.messages[i].role === 'assistant' && !sess.messages[i].done) return sess.messages[i];
  }
  return null;
}

function updateSessTitle(sess) {
  if (sess.title !== '新会话') return;
  const first = sess.messages.find(m => m.role === 'user');
  if (first) {
    const titleText = first.content
      ? (first.content.slice(0, 22) + (first.content.length > 22 ? '…' : ''))
      : (first.attachments && first.attachments.length > 0 ? '[图片/文件]' : '新会话');
    sess.title = titleText;
    renderSessList();
    // 更新顶部标题
    if (isCurrent(sess)) {
      const titleEl = document.getElementById('topbar-title');
      if (titleEl) titleEl.textContent = titleText;
    }
    persistSessions();
  }
}

function renderSessList() {
  dom.sessionList.innerHTML = '';
  [...state.sessions].reverse().forEach(sess => {
    const item = document.createElement('div');
    item.className = 'session-item' + (sess.id === state.currentSessionId ? ' active' : '');

    // 头像
    const avatarEl = document.createElement('div');
    avatarEl.className = 'session-avatar';
    avatarEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/><path d="M9.5 17 C9.5 19 14.5 19 14.5 17"/><path d="M7 6V4M17 6V4"/><rect x="5.5" y="1.5" width="3" height="3" rx="1"/><rect x="15.5" y="1.5" width="3" height="3" rx="1"/></svg>';

    // 信息区
    const info = document.createElement('div');
    info.className = 'session-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'session-title';
    titleEl.textContent = sess.title;
    const subEl = document.createElement('div');
    subEl.className = 'session-subtitle';
    // 显示最后一条消息预览
    const lastMsg = [...sess.messages].reverse().find(m => m.role === 'user' || m.role === 'assistant');
    if (lastMsg) {
      const preview = (lastMsg.content || '').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').trim();
      subEl.textContent = preview ? preview.slice(0, 30) + (preview.length > 30 ? '…' : '') : '[无内容]';
    } else {
      subEl.textContent = (state.gateways[sess.gatewayIdx] || {}).name || ('Gateway ' + sess.gatewayIdx);
    }
    info.appendChild(titleEl);
    info.appendChild(subEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-del-session';
    delBtn.title = '删除';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('删除此会话？')) deleteSession(sess.id);
    });

    item.appendChild(avatarEl);
    item.appendChild(info);
    item.appendChild(delBtn);
    item.addEventListener('click', () => switchSession(sess.id));
    dom.sessionList.appendChild(item);
  });
}

/* ─── 渲染消息列表 ──────────────────────────────── */
function renderMessages(sess) {
  dom.messages.innerHTML = '';
  if (sess.messages.length === 0) {
    dom.messages.appendChild(dom.emptyState);
    return;
  }
  sess.messages.forEach(m => {
    if (m.role === 'user') dom.messages.appendChild(makeUserBubble(m.content, m.attachments));
    else if (m.role === 'assistant') dom.messages.appendChild(makeAssistantRow(m));
    else if (m.role === 'system') dom.messages.appendChild(makeSysBubble(m.content));
  });
  scrollToBottom();
}

function makeUserBubble(text, attachments) {
  const row = document.createElement('div');
  row.className = 'msg-row user';

  // 用户头像（右侧）
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar user-avatar';
  avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20 C4 15 8 13 12 13 C16 13 20 15 20 20"/></svg>';

  // 气泡包装
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  const withArrow = document.createElement('div');
  withArrow.className = 'bubble-with-arrow';

  // 三角箭头
  const arrow = document.createElement('div');
  arrow.className = 'bubble-arrow';

  const bub = document.createElement('div');
  bub.className = 'bubble';

  // 文字内容
  if (text) {
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    bub.appendChild(textSpan);
  }

  // 附件内联显示
  if (attachments && attachments.length > 0) {
    attachments.forEach(att => {
      if (att.mimeType && att.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'bubble-img';
        img.src = 'data:' + att.mimeType + ';base64,' + att.data;
        img.alt = att.filename;
        bub.appendChild(img);
      } else {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'bubble-file';
        fileDiv.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;flex-shrink:0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg> ' + escapeHtml(att.filename);
        bub.appendChild(fileDiv);
      }
    });
  }

  withArrow.appendChild(arrow);
  withArrow.appendChild(bub);
  wrap.appendChild(withArrow);
  row.appendChild(wrap);
  row.appendChild(avatar);
  return row;
}

function makeAssistantRow(msgObj) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.dataset.msgId = msgObj.id;

  // AI头像（左侧）
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar ai-avatar';
  avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="13" rx="2"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><path d="M9.5 17 C9.5 18.5 14.5 18.5 14.5 17"/><path d="M7 6V4M17 6V4"/><rect x="5.5" y="1.5" width="3" height="3" rx="1"/><rect x="15.5" y="1.5" width="3" height="3" rx="1"/></svg>';

  // 气泡包装（含折叠块+气泡）
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';
  wrap.dataset.wrapId = msgObj.id;

  if (msgObj.thinking) {
    wrap.appendChild(makeThinkBlock(msgObj.thinking, /*open=*/false));
  }
  msgObj.tools.forEach(t => wrap.appendChild(makeToolBlock(t)));

  const withArrow = document.createElement('div');
  withArrow.className = 'bubble-with-arrow';

  // 三角箭头
  const arrow = document.createElement('div');
  arrow.className = 'bubble-arrow';

  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.innerHTML = renderMarkdown(msgObj.content);
  if (!msgObj.done) {
    bub.appendChild(makeCursor());
  }

  withArrow.appendChild(arrow);
  withArrow.appendChild(bub);
  wrap.appendChild(withArrow);
  row.appendChild(avatar);
  row.appendChild(wrap);
  return row;
}

function makeSysBubble(text) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:center;padding:4px 0;';
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:12px;color:var(--text3);background:rgba(0,0,0,0.06);padding:3px 10px;border-radius:10px;font-style:italic;max-width:80%;text-align:center;';
  lbl.textContent = text;
  row.appendChild(lbl);
  return row;
}

function makeCursor() {
  const c = document.createElement('span');
  c.className = 'cursor';
  return c;
}

function makeThinkBlock(text, open) {
  const el = document.createElement('div');
  el.className = 'collapsible thinking' + (open ? ' open' : '');
  const hdr = document.createElement('div');
  hdr.className = 'collapsible-header';
  // 灯泡图标
  const icon = document.createElement('span');
  icon.className = 'collapsible-header-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M9 18h6M10 21h4M12 2a7 7 0 0 1 7 7c0 2.5-1.5 4.5-3 6H8C6.5 13.5 5 11.5 5 9a7 7 0 0 1 7-7z"/></svg>';
  const lbl = document.createElement('span');
  lbl.textContent = '思考过程';
  const arr = document.createElement('span');
  arr.className = 'collapsible-arrow';
  arr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  hdr.appendChild(icon);
  hdr.appendChild(lbl);
  hdr.appendChild(arr);
  hdr.addEventListener('click', () => el.classList.toggle('open'));
  const body = document.createElement('div');
  body.className = 'collapsible-body';
  body.textContent = text;
  el.appendChild(hdr);
  el.appendChild(body);
  return el;
}

// 根据工具名返回对应 SVG 图标
function getToolIcon(name) {
  const n = (name || '').toLowerCase();
  if (n === 'exec' || n.includes('exec') || n.includes('shell') || n.includes('run')) {
    // 终端图标
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  }
  if (n === 'web_search' || n.includes('search') || n.includes('browse') || n.includes('web')) {
    // 搜索图标
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  }
  if (n === 'read' || n === 'write' || n.includes('file') || n.includes('read') || n.includes('write')) {
    // 文件图标
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  }
  if (n.includes('browser') || n.includes('click') || n.includes('navigate')) {
    // 浏览器图标
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  }
  if (n.includes('image') || n.includes('photo') || n.includes('vision')) {
    // 图片图标
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  }
  // 默认工具图标（扳手）
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
}

function makeToolBlock(tool) {
  const el = document.createElement('div');
  el.className = 'collapsible';
  el.dataset.toolId = tool.id;
  const hdr = document.createElement('div');
  hdr.className = 'collapsible-header';

  // 工具图标
  const icon = document.createElement('span');
  icon.className = 'collapsible-header-icon';
  icon.innerHTML = getToolIcon(tool.name);

  const lbl = document.createElement('span');
  lbl.textContent = tool.name;

  const arr = document.createElement('span');
  arr.className = 'collapsible-arrow';
  arr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  hdr.appendChild(icon);
  hdr.appendChild(lbl);
  hdr.appendChild(arr);
  hdr.addEventListener('click', () => el.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'collapsible-body';

  const argsLabel = document.createElement('div');
  argsLabel.style.cssText = 'margin-bottom:5px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text3)';
  argsLabel.textContent = '参数';
  const argsPre = document.createElement('pre');
  argsPre.style.cssText = 'margin:0 0 8px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--bg3);padding:6px 8px;border-radius:4px';
  argsPre.textContent = tool.args ? JSON.stringify(tool.args, null, 2) : '(无)';

  const resLabel = document.createElement('div');
  resLabel.style.cssText = 'margin-bottom:5px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text3)';
  resLabel.textContent = '结果';
  const resPre = document.createElement('pre');
  resPre.className = 'tool-result';
  resPre.style.cssText = 'margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all;background:var(--bg3);padding:6px 8px;border-radius:4px';
  resPre.textContent = tool.result !== null ? JSON.stringify(tool.result, null, 2) : '等待结果...';

  body.appendChild(argsLabel);
  body.appendChild(argsPre);
  body.appendChild(resLabel);
  body.appendChild(resPre);
  el.appendChild(hdr);
  el.appendChild(body);
  return el;
}

/* ─── 流式更新 DOM ──────────────────────────────── */
function appendAssistantRow(msgObj) {
  // 移除空状态
  if (dom.emptyState.parentNode === dom.messages) {
    dom.messages.removeChild(dom.emptyState);
  }
  dom.messages.appendChild(makeAssistantRow(msgObj));
  scrollToBottom();
}

function updateBubbleStream(msgObj) {
  const row = dom.messages.querySelector('[data-msg-id="' + msgObj.id + '"]');
  if (!row) return;
  const bub = row.querySelector('.bubble');
  if (!bub) return;
  bub.innerHTML = renderMarkdown(msgObj.content);
  if (!msgObj.done) bub.appendChild(makeCursor());
  scrollToBottom();
}

function updateThinkingBlock(msgObj) {
  const row = dom.messages.querySelector('[data-msg-id="' + msgObj.id + '"]');
  if (!row) return;
  const wrap = row.querySelector('.bubble-wrap');
  const container = wrap || row;
  let thinkEl = container.querySelector('.collapsible.thinking');
  if (!thinkEl) {
    thinkEl = makeThinkBlock(msgObj.thinking, false);
    container.insertBefore(thinkEl, container.firstChild);
  } else {
    thinkEl.querySelector('.collapsible-body').textContent = msgObj.thinking;
  }
}

function addToolBlock(msgObj, tool) {
  const row = dom.messages.querySelector('[data-msg-id="' + msgObj.id + '"]');
  if (!row) return;
  const wrap = row.querySelector('.bubble-wrap');
  const container = wrap || row;
  const withArrow = container.querySelector('.bubble-with-arrow');
  container.insertBefore(makeToolBlock(tool), withArrow || container.querySelector('.bubble'));
  scrollToBottom();
}

function updateToolResult(msgObj, tool) {
  const row = dom.messages.querySelector('[data-msg-id="' + msgObj.id + '"]');
  if (!row) return;
  const toolEl = row.querySelector('[data-tool-id="' + tool.id + '"]');
  if (!toolEl) return;
  const resPre = toolEl.querySelector('.tool-result');
  if (resPre) resPre.textContent = tool.result !== null ? JSON.stringify(tool.result, null, 2) : '';
}

function finalizeLastMsg(sess) {
  const m = lastAsstMsg(sess);
  if (!m) return;
  m.done = true;
  if (isCurrent(sess)) updateBubbleStream(m);
  // 消息完成时保存
  persistSessions();
}

function addSysMsg(sess, text) {
  sess.messages.push({ role: 'system', content: text });
  if (isCurrent(sess)) {
    dom.messages.appendChild(makeSysBubble(text));
    scrollToBottom();
  }
  persistSessions();
}

/* ─── 发送消息 ──────────────────────────────────── */
function updateSendBtn() {
  if (state.isStreaming) {
    dom.btnSend.classList.add('cancel');
    dom.btnSend.title = '取消';
    dom.btnSend.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" fill="white"/></svg>';
  } else {
    dom.btnSend.classList.remove('cancel');
    dom.btnSend.title = '发送';
    dom.btnSend.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  }
}

function sendMessage() {
  if (state.isStreaming) {
    // 取消当前运行
    const sess = state.sessions.find(s => s.id === state.currentSessionId);
    if (sess) wsSend({ type: 'cancel', gateway: sess.gatewayIdx, sessionKey: sess.sessionKey });
    return;
  }

  const text = dom.input.value.trim();
  const hasAttachments = state.attachments.length > 0;
  if (!text && !hasAttachments) return;

  // 确保有活跃会话
  let sess = state.sessions.find(s => s.id === state.currentSessionId);
  if (!sess) sess = createSession();

  // 清空输入框
  dom.input.value = '';
  autoResize(dom.input);

  // 拍摄当前附件快照（避免异步过程中被修改），然后清空
  const pendingAttachments = state.attachments.slice();
  clearAttachments();

  // 异步处理（转 Base64）后再发送
  buildAttachmentsFromFiles(pendingAttachments).then(attachments => {
    // 本地追加用户消息（含附件数据，用于气泡显示）
    const msgRecord = { role: 'user', content: text, attachments };
    sess.messages.push(msgRecord);
    if (dom.emptyState.parentNode === dom.messages) dom.messages.removeChild(dom.emptyState);
    const userRow = makeUserBubble(text, attachments);
    dom.messages.appendChild(userRow);
    scrollToBottom();
    updateSessTitle(sess);
    persistSessions();

    // 发送到后端（断线时入队，userRow 用于半透明状态显示）
    const sendObj = {
      type: 'send',
      gateway: sess.gatewayIdx,
      sessionKey: sess.sessionKey,
      message: text,
    };
    if (attachments.length > 0) sendObj.attachments = attachments;
    wsSend(sendObj, userRow);
  }).catch(err => {
    console.error('Failed to read attachments:', err);
    alert('读取附件失败: ' + err.message);
  });
}

dom.btnSend.addEventListener('click', sendMessage);

dom.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

dom.input.addEventListener('input', () => autoResize(dom.input));

/* 新建会话 */
dom.btnNewSession.addEventListener('click', createSession);

/* 模型切换 */
/* ─── 初始化 ────────────────────────────────────── */
(function init() {
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('oc-theme') || 'dark'; } catch(e) {}
  setTheme(savedTheme);

  // 恢复 sessions
  restoreSessions();
  renderSessList();

  // 渲染当前 session（如果有）
  if (state.currentSessionId) {
    const sess = state.sessions.find(s => s.id === state.currentSessionId);
    if (sess) renderMessages(sess);
  }

  connectWS();
})();
<\/script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// 3. HTTP 服务器
// ─────────────────────────────────────────────
const HTML_PAGE = getHtmlPage(); // 缓存 HTML 字符串

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }
  // 所有路径都返回内嵌 HTML
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(HTML_PAGE);
});

// ─────────────────────────────────────────────
// 4. 前端 WebSocket 服务器
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// ─────────────────────────────────────────────
// 5. GatewayClient — 管理单个 Gateway 的 WS 连接
//    负责: 自动重连、JSON-RPC 协议转换、消息回调
// ─────────────────────────────────────────────
class GatewayClient {
  /**
   * @param {number} idx            - gateway 在 config 数组中的索引
   * @param {object} cfg            - { name, url, token, agentId }
   * @param {Function} onMsg        - (msg) => void, 收到 gateway 消息时回调前端
   * @param {Function} onStatus     - (connected: boolean) => void, 连接状态变化
   */
  constructor(idx, cfg, onMsg, onStatus) {
    this.idx = idx;
    this.cfg = cfg;
    this.onMsg = onMsg;
    this.onStatus = onStatus;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000; // 初始退避延迟 ms

    /** Map<reqId, { sessionKey }> - 追踪 agent 请求 */
    this.pendingReqs = new Map();
    /** Map<sessionKey, runId> - 当前运行 ID（用于取消） */
    this.runIds = new Map();
    this.connect();
  }

  connect() {
    const url = this.cfg.url + (this.cfg.token ? '?token=' + encodeURIComponent(this.cfg.token) : '');
    console.log(`[Gateway ${this.idx}] Connecting to ${this.cfg.url} ...`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error(`[Gateway ${this.idx}] Failed to create WebSocket:`, err.message);
      this.scheduleReconnect();
      return;
    }

    this.ready = false; // 握手完成前不算 ready

    this.ws.on('open', () => {
      console.log(`[Gateway ${this.idx}] WebSocket open, waiting for challenge...`);
      // 不在这里设置 connected=true，等握手完成
    });

    this.ws.on('message', (data) => {
      const raw = data.toString();

      // 处理 text heartbeat (ping/pong)
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === 'ping') {
        try { this.ws.send('pong'); } catch {}
        return;
      }
      if (trimmed === 'pong') return;

      let frame;
      try { frame = JSON.parse(raw); } catch (e) { return; }

      // 处理 connect.challenge 握手
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        const nonce = frame.payload?.nonce;
        console.log(`[Gateway ${this.idx}] Received challenge, sending connect...`);
        this.sendFrame({
          type: 'req',
          id: 'connect',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'gateway-client',
              version: '1.0.0',
              platform: process.platform,
              mode: 'backend',
              displayName: 'OpenClaw WebUI',
            },
            role: 'operator',
            scopes: ['operator.admin'],
            caps: ['tool-events'],
            auth: { token: this.cfg.token },
            device: buildDeviceAuthField(deviceIdentity, this.cfg.token, nonce),
          },
        });
        return;
      }

      // 处理 connect 响应
      if (frame.type === 'res' && frame.id === 'connect') {
        if (frame.ok !== false) {
          console.log(`[Gateway ${this.idx}] Handshake complete (${this.cfg.name})`);
          this.ready = true;
          this.connected = true;
          this.reconnectDelay = 2000;
          this.onStatus(true);
        } else {
          console.error(`[Gateway ${this.idx}] Handshake failed:`, JSON.stringify(frame.error));
          try { this.ws.close(); } catch {}
        }
        return;
      }

      // 握手完成后才处理业务帧
      if (!this.ready) return;

      this.handleFrame(frame);
    });

    this.ws.on('close', () => {
      console.log(`[Gateway ${this.idx}] Disconnected`);
      this.connected = false;
      this.ready = false;
      this.ws = null;
      this.onStatus(false);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // close 事件会随后触发并执行重连
      console.error(`[Gateway ${this.idx}] Error:`, err.message);
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return; // 已有重连计划
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000); // 指数退避，最多30s
      this.connect();
    }, this.reconnectDelay);
  }

  /** 向 Gateway 发送 JSON-RPC 帧 */
  sendFrame(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  /** 向 Gateway 发送业务帧（需要握手完成） */
  sendBusinessFrame(frame) {
    if (!this.ready) return false;
    return this.sendFrame(frame);
  }

  /**
   * 发送用户消息给 Agent
   * @param {string} sessionKey
   * @param {string} message
   * @param {Array}  [attachments]  - [{ filename, mimeType, data(base64), size }]
   */
  sendMessage(sessionKey, message, attachments = []) {
    const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const agentId = this.cfg.agentId || 'main';
    const idempotencyKey = 'acp_' + sessionKey + '_' + Date.now();

    this.pendingReqs.set(reqId, { sessionKey });

    // 构造 message 字段：有附件时用 content array 格式
    let messageContent;
    if (attachments && attachments.length > 0) {
      messageContent = [
        { type: 'text', text: message || '' },
        ...attachments.map(att => {
          if (att.mimeType && att.mimeType.startsWith('image/')) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: att.mimeType,
                data: att.data,
              },
            };
          }
          return {
            type: 'document',
            source: {
              type: 'base64',
              media_type: att.mimeType || 'application/octet-stream',
              data: att.data,
            },
            title: att.filename,
          };
        }),
      ];
    } else {
      messageContent = message;
    }

    this.sendFrame({
      type: 'req',
      id: reqId,
      method: 'agent',
      params: {
        agentId,
        sessionKey,
        message: messageContent,
        deliver: false,
        idempotencyKey,
      },
    });
  }

  /**
   * 取消指定 session 的当前运行
   * @param {string} sessionKey
   */
  cancelRun(sessionKey) {
    const runId = this.runIds.get(sessionKey);
    if (!runId) return;
    this.sendFrame({
      type: 'req',
      id: 'cancel_' + Date.now(),
      method: 'agent.cancel',
      params: { sessionKey, runId },
    });
  }

  /** 处理来自 Gateway 的帧 */
  handleFrame(frame) {
    console.log(`[Gateway ${this.idx}] Frame:`, JSON.stringify(frame).substring(0, 300));

    // 响应帧: 处理 agent 请求返回的 runId
    if (frame.type === 'res') {
      const pending = this.pendingReqs.get(frame.id);
      if (pending && frame.ok !== false && frame.payload && frame.payload.runId) {
        this.runIds.set(pending.sessionKey, frame.payload.runId);
        console.log(`[Gateway ${this.idx}] Got runId=${frame.payload.runId} for session=${pending.sessionKey}`);
      }
      if (frame.ok === false) {
        console.error(`[Gateway ${this.idx}] Request failed:`, JSON.stringify(frame.error || frame));
      }
      this.pendingReqs.delete(frame.id);
      return;
    }

    // 事件帧
    if (frame.type === 'event') {
      if (frame.event === 'agent') {
        this.handleAgentEvent(frame.payload);
      } else if (frame.event === 'chat') {
        console.log(`[Gateway ${this.idx}] Chat event:`, JSON.stringify(frame.payload).substring(0, 200));
      } else {
        console.log(`[Gateway ${this.idx}] Event: ${frame.event}`);
      }
    }
  }

  /**
   * 将 Gateway agent 事件转换为前端消息格式并回调
   * stream 类型: assistant | thinking | tool | lifecycle
   */
  handleAgentEvent(payload) {
    if (!payload) return;
    const { stream, data, runId } = payload;
    // Gateway returns sessionKey with "agent:main:" prefix, strip it for matching
    let sessionKey = payload.sessionKey || '';
    if (sessionKey.startsWith('agent:main:')) {
      sessionKey = sessionKey.slice('agent:main:'.length);
    }
    if (!sessionKey || !stream) return;

    switch (stream) {
      case 'lifecycle': {
        const phase = data && data.phase;
        if (phase === 'start' && runId) {
          this.runIds.set(sessionKey, runId);
        } else if (phase === 'end' || phase === 'cancelled') {
          this.runIds.delete(sessionKey);
        }
        this.onMsg({
          type: 'lifecycle',
          gateway: this.idx,
          sessionKey,
          phase,
          runId,
          message: data && data.message,
        });
        break;
      }

      case 'assistant': {
        const text = (data && (data.delta || data.text)) || '';
        if (text) {
          this.onMsg({ type: 'chunk', gateway: this.idx, sessionKey, text });
        }
        break;
      }

      case 'thinking': {
        const text = (data && (data.delta || data.text)) || '';
        if (text) {
          this.onMsg({ type: 'thinking', gateway: this.idx, sessionKey, text });
        }
        break;
      }

      case 'tool': {
        const phase = data && data.phase;
        if (phase === 'start') {
          this.onMsg({
            type: 'tool_start',
            gateway: this.idx,
            sessionKey,
            name: data.name,
            args: data.arguments,
          });
        } else if (phase === 'result') {
          this.onMsg({
            type: 'tool_result',
            gateway: this.idx,
            sessionKey,
            name: data.name,
            result: data.result,
          });
        }
        break;
      }
    }
  }

  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch(e) {}
      this.ws = null;
    }
  }
}

// ─────────────────────────────────────────────
// 6. 前端客户端集合 & 广播函数
// ─────────────────────────────────────────────
const frontendClients = new Set();

function broadcastToFrontend(msg) {
  for (const client of frontendClients) {
    if (client.readyState !== WebSocket.OPEN || !client._authenticated) continue;

    // Bug 1 修复：对于 agent/chat 事件，检查 sessionKey 是否属于该前端连接
    // 需要过滤的消息类型：lifecycle, chunk, thinking, tool_start, tool_result
    const SESSION_SCOPED_TYPES = new Set(['lifecycle', 'chunk', 'thinking', 'tool_start', 'tool_result']);
    if (SESSION_SCOPED_TYPES.has(msg.type) && msg.sessionKey) {
      if (!client._ownedSessions.has(msg.sessionKey)) {
        // 不属于该前端连接的 session，silently 丢弃
        continue;
      }
    }

    try { client.send(JSON.stringify(msg)); } catch(e) { /* ignore */ }
  }
}

// ─────────────────────────────────────────────
// 7. 初始化 Gateway 连接池
// ─────────────────────────────────────────────
const gatewayClients = GATEWAYS.map((gwCfg, idx) => {
  return new GatewayClient(
    idx,
    gwCfg,
    (msg) => broadcastToFrontend(msg),           // 收到 gateway 消息 -> 转发给所有前端
    (connected) => {                              // 状态变化 -> 通知前端
      broadcastToFrontend({ type: 'status', gateway: idx, connected });
    },
  );
});

// ─────────────────────────────────────────────
// 8. 前端 WebSocket 连接处理
// ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log('[Frontend] New connection from', ip);

  ws.on('error', (err) => {
    console.error('[Frontend] WS error from', ip, err.message);
  });

  ws.on('close', (code, reason) => {
    console.log('[Frontend] Disconnected', ip, 'code=' + code, 'reason=' + (reason || ''));
    frontendClients.delete(ws);
  });

  // 认证状态：无密码时直接标记为已认证
  ws._authenticated = !AUTH_REQUIRED;

  // Bug 1 修复：每个前端连接维护一个 ownedSessions Set，用于过滤事件
  ws._ownedSessions = new Set();

  if (AUTH_REQUIRED) {
    // 告诉前端需要密码
    ws.send(JSON.stringify({ type: 'auth_required' }));
  } else {
    // 无密码保护，直接发送 init
    frontendClients.add(ws);
    sendInitMsg(ws);
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch(e) { return; }

    // 处理认证消息
    if (msg.type === 'auth') {
      if (!AUTH_REQUIRED) {
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        return;
      }
      if (msg.password === PASSWORD) {
        ws._authenticated = true;
        frontendClients.add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        sendInitMsg(ws);
        console.log('[Frontend] Auth OK from', ip);
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail' }));
        console.warn('[Frontend] Auth FAILED from', ip);
      }
      return;
    }

    // 未认证时拒绝其他消息
    if (!ws._authenticated) {
      ws.send(JSON.stringify({ type: 'auth_required' }));
      return;
    }

    handleFrontendMsg(ws, msg);
  });

  // (close and error handlers already registered above)
});

/** 向指定前端发送初始化数据 */
function sendInitMsg(ws) {
  ws.send(JSON.stringify({
    type: 'init',
    models: CONFIG_MODELS,
    gateways: GATEWAYS.map((gw, i) => ({
      name: gw.name,
      connected: gatewayClients[i] ? gatewayClients[i].connected : false,
    })),
  }));
}

/**
 * 处理前端发来的控制消息
 *
 * 支持的消息类型（见 SPEC.md）:
 *   { type: 'send',   gateway, sessionKey, message }
 *   { type: 'cancel', gateway, sessionKey }
 */
function handleFrontendMsg(ws, msg) {
  console.log('[Frontend] Received:', JSON.stringify(msg).substring(0, 200));
  const gwIdx = typeof msg.gateway === 'number' ? msg.gateway : 0;
  const gwClient = gatewayClients[gwIdx];

  if (!gwClient) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid gateway index: ' + gwIdx }));
    return;
  }

  switch (msg.type) {
    case 'send': {
      if (!gwClient.connected) {
        console.log('[Frontend] Gateway not connected, rejecting send');
        ws.send(JSON.stringify({ type: 'error', gateway: gwIdx, message: 'Gateway not connected' }));
        return;
      }
      const sessionKey = msg.sessionKey || ('webui:default_' + gwIdx);

      // Bug 1 修复：前端创建/使用 session 时，把 sessionKey 加入该连接的 ownedSessions Set
      ws._ownedSessions.add(sessionKey);
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

      // 服务端校验附件
      const MAX_SIZE = 10 * 1024 * 1024;
      const ALLOWED_MIME_SRV = new Set([
        'image/png','image/jpeg','image/gif','image/webp',
        'application/pdf','text/plain','text/markdown',
        'text/javascript','text/typescript','text/css','application/json',
      ]);
      const validAttachments = attachments.filter(att => {
        if (!att || !att.data) return false;
        if (att.size && att.size > MAX_SIZE) {
          console.warn('[Frontend] Attachment too large, skipped:', att.filename, att.size);
          return false;
        }
        if (att.mimeType && !ALLOWED_MIME_SRV.has(att.mimeType)) {
          console.warn('[Frontend] Attachment mime type not in whitelist, but allowing:', att.mimeType);
          // 仍然通过，但记录日志
        }
        return true;
      });

      console.log(`[Frontend] Sending to gateway ${gwIdx}, session=${sessionKey}, msg=${(msg.message||'').substring(0,50)}, attachments=${validAttachments.length}`);
      gwClient.sendMessage(sessionKey, msg.message || '', validAttachments);
      break;
    }

    case 'cancel': {
      const sessionKey = msg.sessionKey || ('webui:default_' + gwIdx);
      gwClient.cancelRun(sessionKey);
      break;
    }

    default:
      console.warn('[Frontend] Unknown message type:', msg.type);
  }
}

// ─────────────────────────────────────────────
// 9. 启动 HTTP 服务器
// ─────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════╗');
  console.log('║      OpenClaw WebUI Started         ║');
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log('╚════════════════════════════════════╝');
  console.log('');
  console.log(`Loaded ${GATEWAYS.length} gateway(s):`);
  GATEWAYS.forEach((gw, i) => {
    console.log(`  [${i}] ${gw.name} — ${gw.url}`);
  });
  console.log('');
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  gatewayClients.forEach(c => c.destroy());
  httpServer.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  gatewayClients.forEach(c => c.destroy());
  httpServer.close(() => process.exit(0));
});