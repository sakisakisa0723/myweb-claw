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
      --bg: #ffffff;
      --bg2: #f5f5f5;
      --bg3: #ebebeb;
      --border: #d9d9d9;
      --text: #1a1a1a;
      --text2: #555555;
      --text3: #888888;
      --user-bubble: #1d72e8;
      --user-text: #ffffff;
      --assistant-bg: #f0f4ff;
      --tool-bg: #f7f7f7;
      --tool-border: #d0d0d0;
      --thinking-bg: #fdfaf0;
      --thinking-border: #e8d87a;
      --accent: #1d72e8;
      --danger: #e84040;
      --sidebar-w: 260px;
      --radius: 12px;
    }
    [data-theme="dark"] {
      --bg: #1a1a1a;
      --bg2: #242424;
      --bg3: #2e2e2e;
      --border: #3a3a3a;
      --text: #e8e8e8;
      --text2: #aaaaaa;
      --text3: #666666;
      --user-bubble: #2b5fd4;
      --user-text: #ffffff;
      --assistant-bg: #1e2330;
      --tool-bg: #252525;
      --tool-border: #3a3a3a;
      --thinking-bg: #23200f;
      --thinking-border: #6b5c10;
      --accent: #4d8bff;
    }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      transition: background 0.2s, color 0.2s;
    }

    /* ── 侧边栏 ── */
    #sidebar {
      width: var(--sidebar-w);
      min-width: var(--sidebar-w);
      background: var(--bg2);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      transition: transform 0.25s ease;
      z-index: 100;
    }
    #sidebar-header {
      padding: 16px 12px 10px;
      border-bottom: 1px solid var(--border);
    }
    #sidebar-header h2 {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 10px;
      letter-spacing: 0.3px;
    }
    #btn-new-session {
      width: 100%;
      padding: 8px 0;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: opacity 0.15s;
    }
    #btn-new-session:hover { opacity: 0.85; }

    #session-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 6px;
    }
    .session-item {
      display: flex;
      align-items: center;
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      gap: 8px;
      transition: background 0.15s;
      margin-bottom: 2px;
    }
    .session-item:hover { background: var(--bg3); }
    .session-item.active { background: var(--accent); color: #fff; }
    .session-item.active .session-subtitle { color: rgba(255,255,255,0.7); }
    .session-title {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-subtitle {
      font-size: 11px;
      color: var(--text3);
    }
    .btn-del-session {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text3);
      font-size: 16px;
      padding: 0 2px;
      opacity: 0;
      transition: opacity 0.15s;
      line-height: 1;
    }
    .session-item:hover .btn-del-session { opacity: 1; }
    .session-item.active .btn-del-session { opacity: 0.7; color: #fff; }

    /* ── 主区域 ── */
    #main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── 顶栏 ── */
    #topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    #btn-sidebar-toggle {
      display: none;
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--text);
      padding: 2px 6px;
      border-radius: 6px;
    }
    #btn-sidebar-toggle:hover { background: var(--bg3); }

    select {
      background: var(--bg2);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 13px;
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
      gap: 6px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 13px;
      cursor: pointer;
      color: var(--text);
      user-select: none;
      white-space: nowrap;
      min-width: 140px;
    }
    #model-display:hover, #model-display:focus {
      border-color: var(--accent);
      outline: none;
    }
    .model-arrow { font-size: 10px; color: var(--text3); margin-left: auto; }
    #model-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
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

    #status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #aaa;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    #status-dot.connected { background: #27c45a; }
    #status-dot.connecting { background: #f5a623; animation: pulse 1s infinite; }
    #status-dot.error { background: var(--danger); }
    @keyframes pulse {
      0%,100% { opacity: 1; } 50% { opacity: 0.4; }
    }
    #status-text {
      font-size: 12px;
      color: var(--text3);
      white-space: nowrap;
    }

    #btn-theme {
      margin-left: auto;
      background: none;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 7px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 14px;
    }
    #btn-theme:hover { background: var(--bg3); }

    /* ── 消息区 ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scroll-behavior: smooth;
    }

    .msg-row {
      display: flex;
      flex-direction: column;
      max-width: 820px;
      width: 100%;
    }
    .msg-row.user { align-self: flex-end; align-items: flex-end; }
    .msg-row.assistant { align-self: flex-start; align-items: flex-start; }

    .bubble {
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: 14.5px;
      line-height: 1.65;
      word-break: break-word;
      max-width: 100%;
    }
    .msg-row.user .bubble {
      background: var(--user-bubble);
      color: var(--user-text);
      border-bottom-right-radius: 4px;
    }
    .msg-row.assistant .bubble {
      background: var(--assistant-bg);
      color: var(--text);
      border-bottom-left-radius: 4px;
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
      background: rgba(0,0,0,0.12);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 0.88em;
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
      background: var(--accent);
      vertical-align: text-bottom;
      margin-left: 2px;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* ── 思考/工具折叠块 ── */
    .collapsible {
      margin: 6px 0;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--tool-border);
      width: 100%;
      max-width: 820px;
    }
    .collapsible.thinking { border-color: var(--thinking-border); }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 12px;
      background: var(--tool-bg);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text2);
      user-select: none;
    }
    .collapsible.thinking .collapsible-header { background: var(--thinking-bg); color: #8a7a20; }
    [data-theme="dark"] .collapsible.thinking .collapsible-header { color: #c9a820; }
    .collapsible-arrow {
      font-size: 10px;
      transition: transform 0.2s;
    }
    .collapsible.open .collapsible-arrow { transform: rotate(90deg); }
    .collapsible-body {
      display: none;
      padding: 10px 12px;
      background: var(--tool-bg);
      font-size: 12.5px;
      color: var(--text2);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }
    .collapsible.thinking .collapsible-body { background: var(--thinking-bg); }
    .collapsible.open .collapsible-body { display: block; }

    /* ── 输入区 ── */
    #input-area {
      border-top: 1px solid var(--border);
      padding: 12px 16px;
      padding-bottom: calc(12px + env(safe-area-inset-bottom));
      background: var(--bg);
      display: flex;
      align-items: flex-end;
      gap: 10px;
    }
    #input-wrap {
      flex: 1;
      display: flex;
      align-items: flex-end;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 4px 10px;
      transition: border-color 0.2s;
    }
    #input-wrap:focus-within { border-color: var(--accent); }
    #input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 14.5px;
      line-height: 1.5;
      resize: none;
      max-height: 200px;
      overflow-y: auto;
      padding: 6px 0;
      font-family: inherit;
    }
    #input::placeholder { color: var(--text3); }
    #btn-send {
      background: var(--accent);
      border: none;
      border-radius: 10px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.15s;
    }
    #btn-send:hover { opacity: 0.85; }
    #btn-send svg { width: 18px; height: 18px; fill: #fff; }
    #btn-send.cancel { background: var(--danger); }

    /* ── 空状态 ── */
    #empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--text3);
    }
    #empty-state .logo { font-size: 48px; }
    #empty-state p { font-size: 15px; }

    /* ── 手机端适配 ── */
    @media (max-width: 640px) {
      #sidebar {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        transform: translateX(-100%);
      }
      #sidebar.open { transform: translateX(0); box-shadow: 4px 0 20px rgba(0,0,0,0.2); }
      #btn-sidebar-toggle { display: block; }
      #overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.4);
        z-index: 99;
      }
      #overlay.show { display: block; }
      .msg-row { max-width: 100%; }
    }

    /* ── 滚动条 ── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
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
      font-size: 52px;
      line-height: 1;
    }
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
      padding: 10px 8px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    #btn-clear-sessions {
      width: 100%;
      padding: 7px 0;
      background: none;
      border: 1px solid var(--border);
      color: var(--text3);
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    #btn-clear-sessions:hover {
      background: var(--danger);
      color: #fff;
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

    /* ── 📎 按钮 ── */
    #btn-attach {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text3);
      font-size: 20px;
      padding: 4px 6px;
      border-radius: 7px;
      line-height: 1;
      flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
      display: flex;
      align-items: center;
    }
    #btn-attach:hover { color: var(--accent); background: var(--bg3); }

    /* ── 拖拽遮罩 ── */
    #drag-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(29, 114, 232, 0.18);
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
      background: rgba(255,255,255,0.15);
      border-radius: 6px;
      padding: 5px 8px;
    }
  </style>
</head>
<body data-theme="dark">

<!-- 密码验证界面 -->
<div id="auth-screen">
  <div id="auth-card">
    <div id="auth-logo">🐾</div>
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
  <div>📎</div>
  <div>松开鼠标以上传文件</div>
</div>

<!-- 隐藏的文件选择器 -->
<input type="file" id="file-input" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/javascript,text/typescript,text/css,application/json" style="display:none" />

<!-- ── 侧边栏 ── -->
<aside id="sidebar">
  <div id="sidebar-header">
    <h2>🐾 OpenClaw</h2>
    <button id="btn-new-session">＋ 新建会话</button>
  </div>
  <div id="session-list"></div>
  <div id="sidebar-footer">
    <button id="btn-clear-sessions">🗑 清空所有会话</button>
  </div>
</aside>

<!-- ── 主区域 ── -->
<div id="main">
  <!-- 顶栏 -->
  <div id="topbar">
    <button id="btn-sidebar-toggle">☰</button>
    <select id="sel-gateway" title="选择 Gateway"></select>
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
    <span id="status-text">未连接</span>
    <button id="btn-theme" title="切换主题">☀️</button>
  </div>

  <!-- 消息区 -->
  <div id="messages">
    <div id="empty-state">
      <div class="logo">🐾</div>
      <p>选择或新建一个会话，开始对话</p>
    </div>
  </div>

  <!-- 附件预览条 -->
  <div id="attachment-preview"></div>

  <!-- 输入区 -->
  <div id="input-area">
    <div id="input-wrap">
      <button id="btn-attach" title="添加附件">📎</button>
      <textarea id="input" rows="1" placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"></textarea>
    </div>
    <button id="btn-send" title="发送">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
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
      icon.textContent = file.type === 'application/pdf' ? '📄' : '📝';
      item.appendChild(icon);
    }

    const name = document.createElement('div');
    name.className = 'att-name';
    name.textContent = file.name;
    name.title = file.name + ' (' + (file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1)+'MB' : (file.size/1024).toFixed(0)+'KB') + ')';
    item.appendChild(name);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'att-remove';
    rmBtn.textContent = '✕';
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
  dom.btnTheme.textContent = t === 'dark' ? '☀️' : '🌙';
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
  dom.statusText.textContent = pending > 0 ? text + ' · ' + pending + ' 条消息待发送' : text;
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
    state.wsConnected = true;
    setStatus('connected', '已连接');
    // pending 消息在 auth_ok（有密码）或收到 init（无密码）后冲刷
    // 对于无密码的情况，等收到 init 消息后再标记 authenticated 并冲刷
  });

  ws.addEventListener('close', () => {
    state.wsConnected = false;
    state.ws = null;
    state.authenticated = false; // 断线后重置认证状态
    const pending = state.pendingMessages.length;
    setStatus('error', pending > 0 ? '连接断开，重连中...' : '连接断开，重连中...');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => {
    setStatus('error', '连接错误');
  });

  ws.addEventListener('message', evt => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch(e) { return; }
    handleServerMsg(msg);
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
        lbl.textContent = '⏳ 发送中...';
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
          addSysMsg(sess, '❌ 错误: ' + (msg.message || '未知错误'));
        } else if (msg.phase === 'cancelled') {
          addSysMsg(sess, '⚠️ 已取消');
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
    persistSessions();
  }
}

function renderSessList() {
  dom.sessionList.innerHTML = '';
  [...state.sessions].reverse().forEach(sess => {
    const item = document.createElement('div');
    item.className = 'session-item' + (sess.id === state.currentSessionId ? ' active' : '');

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;overflow:hidden';
    const titleEl = document.createElement('div');
    titleEl.className = 'session-title';
    titleEl.textContent = sess.title;
    const subEl = document.createElement('div');
    subEl.className = 'session-subtitle';
    subEl.textContent = (state.gateways[sess.gatewayIdx] || {}).name || ('Gateway ' + sess.gatewayIdx);
    info.appendChild(titleEl);
    info.appendChild(subEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-del-session';
    delBtn.title = '删除';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('删除此会话？')) deleteSession(sess.id);
    });

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
        // 非图片：显示文件名
        const fileDiv = document.createElement('div');
        fileDiv.className = 'bubble-file';
        const icon = att.mimeType === 'application/pdf' ? '📄' : '📝';
        fileDiv.textContent = icon + ' ' + att.filename;
        bub.appendChild(fileDiv);
      }
    });
  }

  row.appendChild(bub);
  return row;
}

function makeAssistantRow(msgObj) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.dataset.msgId = msgObj.id;

  if (msgObj.thinking) {
    row.appendChild(makeThinkBlock(msgObj.thinking, /*open=*/false));
  }
  msgObj.tools.forEach(t => row.appendChild(makeToolBlock(t)));

  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.innerHTML = renderMarkdown(msgObj.content);
  if (!msgObj.done) {
    bub.appendChild(makeCursor());
  }
  row.appendChild(bub);
  return row;
}

function makeSysBubble(text) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.style.cssText = 'font-size:12px;opacity:0.7;font-style:italic';
  bub.textContent = text;
  row.appendChild(bub);
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
  const arr = document.createElement('span');
  arr.className = 'collapsible-arrow';
  arr.textContent = '▶';
  const lbl = document.createElement('span');
  lbl.textContent = '💭 思考过程';
  hdr.appendChild(arr);
  hdr.appendChild(lbl);
  hdr.addEventListener('click', () => el.classList.toggle('open'));
  const body = document.createElement('div');
  body.className = 'collapsible-body';
  body.textContent = text;
  el.appendChild(hdr);
  el.appendChild(body);
  return el;
}

function makeToolBlock(tool) {
  const el = document.createElement('div');
  el.className = 'collapsible';
  el.dataset.toolId = tool.id;
  const hdr = document.createElement('div');
  hdr.className = 'collapsible-header';
  const arr = document.createElement('span');
  arr.className = 'collapsible-arrow';
  arr.textContent = '▶';
  const lbl = document.createElement('span');
  lbl.textContent = '🔧 ' + tool.name;
  hdr.appendChild(arr);
  hdr.appendChild(lbl);
  hdr.addEventListener('click', () => el.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'collapsible-body';

  const argsLabel = document.createElement('div');
  argsLabel.style.cssText = 'margin-bottom:6px;font-weight:600';
  argsLabel.textContent = '参数:';
  const argsPre = document.createElement('pre');
  argsPre.style.cssText = 'margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all';
  argsPre.textContent = tool.args ? JSON.stringify(tool.args, null, 2) : '';

  const resLabel = document.createElement('div');
  resLabel.style.cssText = 'margin:8px 0 4px;font-weight:600';
  resLabel.textContent = '结果:';
  const resPre = document.createElement('pre');
  resPre.className = 'tool-result';
  resPre.style.cssText = 'margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all';
  resPre.textContent = tool.result !== null ? JSON.stringify(tool.result, null, 2) : '⏳ 等待结果...';

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
  let thinkEl = row.querySelector('.collapsible.thinking');
  if (!thinkEl) {
    thinkEl = makeThinkBlock(msgObj.thinking, false);
    row.insertBefore(thinkEl, row.firstChild);
  } else {
    thinkEl.querySelector('.collapsible-body').textContent = msgObj.thinking;
  }
}

function addToolBlock(msgObj, tool) {
  const row = dom.messages.querySelector('[data-msg-id="' + msgObj.id + '"]');
  if (!row) return;
  const bub = row.querySelector('.bubble');
  row.insertBefore(makeToolBlock(tool), bub);
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
  const json = JSON.stringify(msg);
  for (const client of frontendClients) {
    if (client.readyState === WebSocket.OPEN && client._authenticated) {
      try { client.send(json); } catch(e) { /* ignore */ }
    }
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

  // 认证状态：无密码时直接标记为已认证
  ws._authenticated = !AUTH_REQUIRED;

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

  ws.on('close', () => {
    console.log('[Frontend] Disconnected', ip);
    frontendClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Frontend] Error:', err.message);
    frontendClients.delete(ws);
  });
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