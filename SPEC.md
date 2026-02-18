# OpenClaw WebUI - 技术规范

## 项目概述
一个独立的Web聊天界面，通过WebSocket直接连接OpenClaw Gateway，实现流式输出的AI对话体验。
类似Kimi Claw但前端完全自控，手机端友好。

## 架构

```
浏览器 (手机/PC)
    ↕ HTTP + WebSocket
Node.js 服务器 (本机 port 18890)
    ↕ WebSocket (JSON-RPC)
OpenClaw Gateway (ws://127.0.0.1:18789)
```

## 核心功能

### 必须实现
1. **流式对话** - 实时显示AI回复的每个chunk
2. **Markdown渲染** - 代码高亮、表格、列表等
3. **多Session** - 创建、切换、删除会话
4. **模型切换** - 在界面上切换不同模型
5. **手机端适配** - 响应式设计，触摸友好
6. **暗色/亮色主题**
7. **多Gateway支持** - 可配置连接多个gateway

### 后续可加
- 文件/图片上传
- 历史消息加载
- PWA支持

## Gateway WebSocket 协议

### 连接
- URL: `ws://127.0.0.1:18789`
- 认证: 连接后通过frame发送，或URL参数带token

### 帧格式 (JSON)

**请求帧:**
```json
{
  "type": "req",
  "id": "req_唯一ID",
  "method": "方法名",
  "params": { ... }
}
```

**响应帧:**
```json
{
  "type": "res",
  "id": "对应请求ID",
  "ok": true/false,
  "payload": { ... }
}
```

**事件帧:**
```json
{
  "type": "event",
  "event": "事件名",
  "payload": { ... }
}
```

### 关键方法

#### 发送消息: `agent`
```json
{
  "type": "req",
  "id": "req_xxx",
  "method": "agent",
  "params": {
    "agentId": "main",
    "sessionKey": "agent:main:main",
    "message": "用户消息内容",
    "deliver": false,
    "idempotencyKey": "acp_agent:main:main_1234567890"
  }
}
```

响应会返回 `runId`。之后通过event帧接收streaming数据。

#### 取消运行: `agent.cancel`
```json
{
  "type": "req",
  "id": "cancel_xxx",
  "method": "agent.cancel",
  "params": {
    "sessionKey": "agent:main:main",
    "runId": "要取消的runId"
  }
}
```

#### Session设置: `sessions.patch`
```json
{
  "type": "req",
  "id": "sess_patch_xxx",
  "method": "sessions.patch",
  "params": {
    "key": "agent:main:main",
    "verboseLevel": "on",
    "reasoningLevel": "stream"
  }
}
```

### 事件类型

#### `event: "agent"` - AI回复流
payload结构:
```json
{
  "stream": "assistant|thinking|tool|lifecycle",
  "data": { ... },
  "runId": "xxx",
  "sessionKey": "agent:main:main"
}
```

**stream类型:**

1. `assistant` - 文本回复chunk
   - `data.delta` 或 `data.text`: 文本增量
   
2. `thinking` - 思考过程
   - `data.delta` 或 `data.text`: 思考文本
   
3. `tool` - 工具调用
   - `data.phase`: "start" | "result"
   - `data.name`: 工具名
   - `data.arguments`: 调用参数 (start时)
   - `data.result`: 返回结果 (result时)
   
4. `lifecycle` - 生命周期
   - `data.phase`: "start" | "end" | "error" | "cancelled"
   - start: 开始新的agent运行
   - end: 运行完成
   - error: 运行出错，`data.message` 有错误信息

#### `event: "chat"` - 完整消息回放
payload包含 `message` 对象，有 `role` 和 `content`。
主要用于历史消息同步。

#### `event: "cron"` - 定时任务相关
payload包含cron任务信息，可用于显示后台任务状态。

### 认证

Gateway连接认证方式:
```
ws://127.0.0.1:18789?token=你的token
```

或在连接建立后发送auth帧（具体看gateway实现）。

建议: 后端Node.js服务连gateway，前端连Node.js服务，不直接暴露gateway。

## 前端技术栈

- **不使用框架** - 纯HTML/CSS/JS，单文件内嵌到Node.js中（像现有webui-js那样）
- **Markdown**: marked.js + highlight.js
- **WebSocket**: 原生 WebSocket API
- **样式**: CSS变量 + 响应式

## 前端UI设计

### 布局
- 左侧: Session列表侧边栏（手机端可折叠）
- 顶部: 模型选择 + 连接状态 + Gateway选择
- 中间: 聊天消息区
- 底部: 输入区（textarea + 发送按钮）

### 消息展示
- 用户消息: 右对齐气泡
- AI消息: 左对齐，Markdown渲染
- 工具调用: 可折叠的灰色块
- 思考过程: 可折叠的灰色块（默认折叠）
- 流式输出: 逐字显示 + 打字光标动画

### 手机端
- 侧边栏默认隐藏，汉堡菜单打开
- 输入框自适应高度
- 触摸滚动流畅
- safe-area适配

## 后端设计

### Node.js服务 (port 18890)

```
GET /              → 返回HTML页面
GET /health        → 健康检查
WS  /ws            → 前端WebSocket连接
```

### Gateway连接管理

```javascript
// 配置文件 config.json
{
  "gateways": [
    {
      "name": "Oracle VPS",
      "url": "ws://127.0.0.1:18789",
      "token": "your-token",
      "agentId": "main"
    },
    {
      "name": "Mac mini",
      "url": "ws://100.70.161.69:18789",
      "token": "another-token",
      "agentId": "main"
    }
  ],
  "port": 18890
}
```

### WebSocket消息转发

后端作为中间代理:
1. 前端 → 后端: 用户消息 + 目标gateway
2. 后端 → gateway: 转换为gateway协议帧
3. gateway → 后端: streaming事件
4. 后端 → 前端: 转发streaming chunk

前端到后端的消息格式:
```json
// 发送消息
{ "type": "send", "gateway": 0, "sessionKey": "agent:main:main", "message": "hello" }

// 切换模型 (通过发送/model命令)
{ "type": "send", "gateway": 0, "sessionKey": "agent:main:main", "message": "/model sonnet" }

// 取消
{ "type": "cancel", "gateway": 0, "sessionKey": "agent:main:main" }

// 新建session
{ "type": "new_session", "gateway": 0 }
```

后端到前端的消息格式:
```json
// 连接状态
{ "type": "status", "gateway": 0, "connected": true }

// 文本chunk
{ "type": "chunk", "gateway": 0, "sessionKey": "...", "text": "增量文本" }

// 思考chunk
{ "type": "thinking", "gateway": 0, "sessionKey": "...", "text": "思考内容" }

// 工具调用开始
{ "type": "tool_start", "gateway": 0, "sessionKey": "...", "name": "exec", "args": {...} }

// 工具调用结果
{ "type": "tool_result", "gateway": 0, "sessionKey": "...", "name": "exec", "result": "..." }

// 生命周期
{ "type": "lifecycle", "gateway": 0, "sessionKey": "...", "phase": "start|end|error" }

// 错误
{ "type": "error", "gateway": 0, "message": "错误信息" }
```

## 文件结构

```
openclaw-webui/
├── SPEC.md           # 本文档
├── config.json       # 配置文件
├── package.json
├── server.js         # Node.js 后端（含内嵌HTML）
└── README.md
```

目标: 整个项目就一个 server.js 文件（HTML/CSS/JS内嵌），加一个 config.json。
部署就是 `node server.js`。

## 认证握手协议（重要！）

Gateway连接不是简单的token URL参数认证。完整流程：

1. WebSocket连接 `ws://host:port`（不需要URL带token）
2. 收到 `connect.challenge` 事件，含 nonce
3. 发送 `connect` 请求，包含：
   - `client.id`: 必须是 `"gateway-client"`
   - `client.mode`: 必须是 `"backend"`
   - `minProtocol/maxProtocol`: 3
   - `role`: `"operator"`
   - `scopes`: `["operator.admin"]`
   - `caps`: `["tool-events"]`
   - `auth.token`: gateway token
   - `device`: Ed25519签名字段（id, publicKey, signature, signedAt, nonce）
4. 收到 connect 响应，ok=true 表示握手成功

### Device签名生成
- 生成Ed25519密钥对，持久化到 device.json
- 签名payload格式: `v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`
- 用私钥签名，公钥和签名用base64url编码

### SessionKey注意事项
- 前端使用的sessionKey如 `webui:sess_xxx`
- Gateway返回的事件中sessionKey会带 `agent:main:` 前缀，如 `agent:main:webui:sess_xxx`
- 后端需要strip这个前缀再转发给前端匹配

## 当前状态

### 已实现 ✅
- Gateway WebSocket连接 + 认证握手
- 流式对话（逐字显示）
- Markdown渲染 + 代码高亮
- 多Session管理（前端）
- 暗色/亮色主题
- 手机端响应式
- 工具调用/思考过程可折叠显示

### 已知Bug 🐛（优先修复）

#### Bug 1: 事件路由泄漏
**问题**: WebUI前端会收到不属于当前webui session的事件（如main session的错误），导致前端显示"未知错误"。
**根因**: 后端将gateway的所有agent/chat事件都转发给了前端，没有按sessionKey过滤。
**修复**: 后端在转发事件给前端时，必须检查事件的 `sessionKey` 是否属于该前端连接拥有的session列表。不匹配的事件应该silently丢弃。

#### Bug 2: 断连后消息丢失
**问题**: 前端WebSocket断连后重连，期间如果AI正在回复，重连后消息丢失且无法恢复。用户发一条消息后如果网络抖动断连，重连后看不到AI的回复。
**修复方案**: 
- 前端断连期间禁止发送消息（输入框+发送按钮disabled，显示"连接中..."状态）
- 重连成功后，自动恢复连接状态
- 如果有正在进行的AI回复（lifecycle未收到end），显示"回复可能已中断，请重新发送"的提示
- **核心原则**: 没连上就不让发，避免用户以为发出去了实际丢了

### 待实现 🔲
1. **密码保护** - config.json里配置密码，前端输入密码后才能使用，支持localStorage保存
2. **Session持久化** - 刷新后session列表和聊天记录不丢失（当前纯内存，刷新即清空）
3. **模型列表** - 从gateway获取实际可用模型列表（当前未实现正确的模型获取）
4. 多Gateway实际测试
5. **文件/图片上传** - 详见下方《发送图片与文件功能规范》
6. PWA支持
7. 安装脚本（类似kimi-claw的install.sh）

### UI大改版 🎨（本轮重点）

#### 设计目标
高度还原微信聊天界面风格（但不出现任何"微信"/"WeChat"字样），极简扁平设计。

#### 设计规范
- **图标风格**: 极简线条扁平图标，**禁止使用任何emoji**（包括按钮、状态指示、侧边栏等所有地方）
- **配色**: 
  - 亮色模式：微信风格的灰白底 `#EDEDED` + 白色聊天区 + 绿色发送按钮 `#07C160`
  - 暗色模式：深灰底色，保持同样的极简风格
- **消息气泡**: 
  - 用户消息：绿色气泡（微信风格 `#95EC69`），右对齐
  - AI消息：白色气泡，左对齐
  - 圆角矩形，带小三角尖角指向头像方向
- **头像**: 左侧AI头像（简单的机器人线条图标），右侧用户头像（简单的人形线条图标）
- **顶部导航栏**: 微信风格，中间显示session名称，左侧返回箭头（到session列表），右侧设置按钮
- **输入区**: 微信风格底部输入栏，白色圆角输入框 + 右侧发送按钮（绿色）
- **侧边栏/Session列表**: 微信对话列表风格，每个session显示最后一条消息预览
- **工具调用显示**: 美化为可折叠卡片样式，使用极简线条图标表示不同工具类型（终端图标=exec, 搜索图标=web_search, 文件图标=read/write 等），不要用emoji
- **思考过程**: 折叠卡片，浅灰背景，斜体文字，极简"灯泡"线条图标
- **全局字体**: 系统默认字体栈（-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif）
- **动画**: 消息发送/接收有微信风格的滑入动画，流畅但不花哨
- **状态指示**: 用极简线条图标，不用emoji（✓送达用线条勾，⏳等待用线条沙漏等）

---

## 发送图片与文件功能规范

### 前端设计

#### UI 入口（输入框区域）
- 在 textarea 左侧（或 input-wrap 内左侧）新增 📎 图标按钮
- 点击 📎 弹出隐藏的 `<input type="file">` 文件选择器
- 支持多选文件（`multiple` 属性）
- 按钮样式与发送按钮协调，hover 时高亮

#### 支持的上传触发方式
1. **点击 📎 按钮** - 打开系统文件选择器
2. **拖拽上传** - 拖拽文件到聊天区域（`#messages`）时触发，显示拖拽高亮遮罩
3. **粘贴上传** - 在输入框聚焦时 `Ctrl+V` / 手机长按粘贴，支持粘贴截图和复制的图片
   - 监听 `paste` 事件，提取 `clipboardData.items` 中的 `image/*` 类型文件

#### 图片预览区
- 文件选定后，在输入框上方显示预览条（`#attachment-preview`）
- 图片类型：缩略图（100×100px，`object-fit: cover`）
- 非图片文件：文件图标 + 文件名 + 大小
- 每个预览项右上角有 ✕ 按钮，可单独移除
- 发送后自动清空预览区

#### 发送流程（前端）
1. 用户选择/拖拽/粘贴文件，存入 `attachments[]` 数组（`File` 对象）
2. 点击发送时，先将文件读取为 Base64（`FileReader.readAsDataURL`）
3. 将 Base64 数据连同消息文本一起发送给后端：
```json
{
  "type": "send",
  "gateway": 0,
  "sessionKey": "webui:sess_xxx",
  "message": "用户输入的文字（可为空）",
  "attachments": [
    {
      "filename": "screenshot.png",
      "mimeType": "image/png",
      "data": "base64编码的文件内容（不含data:前缀）",
      "size": 102400
    }
  ]
}
```
4. 消息气泡中内联显示图片缩略图（`<img>` 标签）

#### 文件限制（前端校验）
- 单文件大小上限：**10 MB**（超出弹出提示，不加入队列）
- 单次最多附件数：**5 个**
- 支持的文件类型：
  - 图片：`image/png`, `image/jpeg`, `image/gif`, `image/webp`
  - 文档：`application/pdf`, `text/plain`, `text/markdown`
  - 代码：`text/javascript`, `text/typescript`, `text/css`, `application/json`
- 不支持的类型显示警告，但仍允许上传（服务端二次校验）

---

### 后端设计（server.js）

#### HTTP 文件上传端点（可选备用方案）
- `POST /upload` — 接收 `multipart/form-data`，返回文件 ID
- 适用于大文件（>1MB），避免 WebSocket 帧过大

#### WebSocket 消息处理（主流程）
在 `handleFrontendMsg` 的 `case 'send'` 分支中：
1. 检测 `msg.attachments` 是否存在
2. 对每个附件做服务端校验：
   - 大小 ≤ 10MB
   - MIME 类型白名单验证
3. 转换 Base64 data 为 Buffer，构造 Gateway 消息

```javascript
// 后端处理示例（伪代码）
case 'send': {
  const attachments = (msg.attachments || []).map(att => ({
    filename: att.filename,
    mimeType: att.mimeType,
    data: att.data,   // Base64字符串
    size: att.size,
  }));
  gwClient.sendMessage(sessionKey, msg.message || '', attachments);
  break;
}
```

---

### Gateway 协议 — 消息附件格式

Gateway 的 `agent` 方法 `params.message` 字段支持多内容块（content array）格式，
参考 OpenClaw 的消息格式（兼容 Anthropic Messages API 的 content 结构）：

#### 纯文本消息（现有）
```json
{
  "method": "agent",
  "params": {
    "agentId": "main",
    "sessionKey": "agent:main:webui:sess_xxx",
    "message": "用户文字",
    "deliver": false,
    "idempotencyKey": "acp_xxx"
  }
}
```

#### 带图片附件的消息
```json
{
  "method": "agent",
  "params": {
    "agentId": "main",
    "sessionKey": "agent:main:webui:sess_xxx",
    "message": [
      {
        "type": "text",
        "text": "用户输入的文字（可为空字符串）"
      },
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "iVBORw0KGgo..."
        }
      }
    ],
    "deliver": false,
    "idempotencyKey": "acp_xxx"
  }
}
```

#### 带文档附件的消息（PDF、文本等）
```json
{
  "method": "agent",
  "params": {
    "message": [
      { "type": "text", "text": "请帮我分析这份文档" },
      {
        "type": "document",
        "source": {
          "type": "base64",
          "media_type": "application/pdf",
          "data": "JVBERi0x..."
        },
        "title": "report.pdf"
      }
    ]
  }
}
```

**注意事项：**
- `message` 字段可以是字符串（纯文本，现有行为）或数组（多内容块）
- 图片走 `type: "image"` + `source.type: "base64"`，与 Anthropic Vision API 完全兼容
- 文档走 `type: "document"`，Gateway 会根据模型能力决定是否支持
- 不支持 Vision 的模型（如 GPT-4o-mini）需要后端降级处理：提取文本或提示用户

#### GatewayClient.sendMessage 签名扩展
```javascript
/**
 * @param {string} sessionKey
 * @param {string} message         - 文字内容
 * @param {Array}  [attachments]   - 附件数组 [{ filename, mimeType, data(base64), size }]
 */
sendMessage(sessionKey, message, attachments = []) {
  const content = attachments.length === 0
    ? message
    : [
        { type: 'text', text: message || '' },
        ...attachments.map(att => {
          if (att.mimeType.startsWith('image/')) {
            return { type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } };
          }
          return { type: 'document', source: { type: 'base64', media_type: att.mimeType, data: att.data }, title: att.filename };
        }),
      ];
  // 发送 content 到 Gateway
}
```

---

### 实现优先级

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 📎 点击选择图片 | P0 | 最基础，先实现图片 |
| 图片预览 + 移除 | P0 | UX 必须 |
| 粘贴上传截图 | P1 | 高频使用场景 |
| 拖拽上传 | P1 | 桌面端常用 |
| 非图片文件（PDF等）| P2 | 需要模型支持 |
| 大文件 POST /upload | P2 | 超过1MB时切换 |
| 视频上传 | P3 | 暂不支持 |

## 部署

```bash
# 安装
cd /home/ubuntu/openclaw-webui
npm init -y
npm install ws

# 配置
# 编辑 config.json 填入gateway信息

# 运行（推荐用screen保持后台）
screen -dmS webui bash -c 'cd /home/ubuntu/openclaw-webui && node server.js'

# 查看日志
screen -r webui

# nginx反代（必须开启WebSocket支持）
# proxy_pass http://127.0.0.1:18890
# proxy_http_version 1.1
# proxy_set_header Upgrade $http_upgrade
# proxy_set_header Connection "upgrade"
```
