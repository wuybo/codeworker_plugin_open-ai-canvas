/**
 * 电商客服自动对话助手 — 后台服务入口
 * 基于 ChatGPT-On-CS（AGPL-3.0）CDP 注入思路改写
 *
 * 职责：
 *   1. 启动 localhost HTTP 服务（仅 127.0.0.1），供 iframe UI 调用
 *   2. 通过 CDP (Chrome DevTools Protocol) 挂接各平台商家客户端的 WebView
 *   3. 轮询读取买家消息、按策略自动/手动发送回复
 *   4. 管理平台连接、会话列表、知识库
 *
 * 环境变量（由 Code Worker 宿主注入）：
 *   CODE_WORKER_PLUGIN_ID      插件 ID
 *   CODE_WORKER_PLUGIN_DIR      插件安装目录
 *   CODE_WORKER_PLUGIN_DATA_DIR 插件私有数据目录
 *
 * 许可证：AGPL-3.0
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CDPManager } = require('./cdp');
const { PlatformAdapters } = require('./platforms');

// ========== 配置 ==========
const SERVICE_PORT = 17389;
const POLL_INTERVAL = 3000; // 消息轮询间隔

// ========== 全局状态 ==========
const state = {
  token: null,              // 随机生成的 API token
  conversations: new Map(), // convId → { id, platform, buyerName, lastMessage, lastTime, unread, messages: [] }
  platforms: new Map(),     // platformId → { connected, error, cdpTarget, adapter }
  autoReply: false,         // 自动回复开关
  knowledge: '',            // 知识库文本
  knowledgeObj: null,       // 解析后的知识库 JSON
  settings: {},             // 用户设置
  cdpManager: null,         // CDP 管理器实例
  server: null,             // HTTP 服务实例
};

// ========== 数据目录 ==========
const DATA_DIR = process.env.CODE_WORKER_PLUGIN_DATA_DIR ||
  path.join(process.env.APPDATA || process.env.HOME || '.', 'ecom-cs-bot-data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSettings() {
  const file = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(file)) {
    try { state.settings = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { state.settings = {}; }
  }
  // 读取 servicePort 配置
  const port = state.settings.servicePort || SERVICE_PORT;
  return port;
}

function saveSettings(s) {
  state.settings = { ...state.settings, ...s };
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(state.settings, null, 2));
}

function loadKnowledge() {
  const file = path.join(DATA_DIR, 'knowledge.json');
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      state.knowledge = data.text || '';
    } catch (e) { state.knowledge = ''; }
  }
  try { state.knowledgeObj = JSON.parse(state.knowledge); } catch (e) { state.knowledgeObj = null; }
}

// ========== HTTP 工具 ==========
function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // CORS — 仅允许 null origin（sandbox iframe）
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plugin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  // 对非 OPTIONS 请求校验 token
  if (req.method === 'OPTIONS') return true;
  // 健康检查和 token 获取端点不需要认证
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/health' || url.pathname === '/api/token') return true;
  const token = req.headers['x-plugin-token'];
  if (!state.token) return true; // token 未初始化时允许（首次启动）
  return token === state.token;
}

// ========== API 路由 ==========
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method;

  // CORS 预检
  if (method === 'OPTIONS') return sendJSON(res, 204, {});

  // 认证
  if (!authenticate(req)) return sendJSON(res, 401, { error: 'unauthorized' });

  try {
    // ---- 健康检查 ----
    if (p === '/api/health' && method === 'GET') {
      return sendJSON(res, 200, { ok: true, version: '0.1.0', uptime: process.uptime() });
    }

    // ---- 获取 token（UI 首次连接时调用） ----
    if (p === '/api/token' && method === 'GET') {
      return sendJSON(res, 200, { token: state.token });
    }

    // ---- 会话列表 ----
    if (p === '/api/conversations' && method === 'GET') {
      const list = Array.from(state.conversations.values()).map(c => ({
        id: c.id,
        platform: c.platform,
        buyerName: c.buyerName,
        lastMessage: c.messages.length > 0 ? c.messages[c.messages.length - 1].content : '',
        lastTime: c.messages.length > 0 ? c.messages[c.messages.length - 1].timestamp : null,
        unread: c.unread,
      }));
      return sendJSON(res, 200, { conversations: list });
    }

    // ---- 会话消息 ----
    const convMatch = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (convMatch && method === 'GET') {
      const convId = convMatch[1];
      const conv = state.conversations.get(convId);
      if (!conv) return sendJSON(res, 404, { error: 'conversation not found' });
      conv.unread = 0; // 清除未读
      return sendJSON(res, 200, { messages: conv.messages });
    }

    // ---- 发送回复 ----
    const replyMatch = p.match(/^\/api\/conversations\/([^/]+)\/reply$/);
    if (replyMatch && method === 'POST') {
      const convId = replyMatch[1];
      const conv = state.conversations.get(convId);
      if (!conv) return sendJSON(res, 404, { error: 'conversation not found' });
      const body = await readBody(req);
      if (!body.content || typeof body.content !== 'string') {
        return sendJSON(res, 400, { error: 'content required' });
      }
      // 通过 CDP 发送消息到平台
      const adapter = state.platforms.get(conv.platform)?.adapter;
      if (!adapter) return sendJSON(res, 400, { error: 'platform not connected' });
      await adapter.sendMessage(conv, body.content);
      // 记录消息
      conv.messages.push({
        from: 'agent',
        content: body.content,
        timestamp: Date.now(),
        aiGenerated: body.aiGenerated || false,
      });
      return sendJSON(res, 200, { ok: true });
    }

    // ---- 自动回复开关 ----
    if (p === '/api/auto-reply' && method === 'POST') {
      const body = await readBody(req);
      state.autoReply = !!body.enabled;
      log(`自动回复 ${state.autoReply ? '已开启' : '已关闭'}`);
      return sendJSON(res, 200, { ok: true, autoReply: state.autoReply });
    }

    // ---- 平台状态 ----
    if (p === '/api/platforms/status' && method === 'GET') {
      const statuses = {};
      for (const [id, info] of state.platforms) {
        statuses[id] = { connected: info.connected, error: info.error || null };
      }
      return sendJSON(res, 200, { statuses });
    }

    // ---- 平台连接/断开 ----
    const platMatch = p.match(/^\/api\/platforms\/([^/]+)\/(connect|disconnect)$/);
    if (platMatch && method === 'POST') {
      const platId = platMatch[1];
      const action = platMatch[2];
      if (action === 'connect') {
        await connectPlatform(platId);
      } else {
        await disconnectPlatform(platId);
      }
      const info = state.platforms.get(platId);
      return sendJSON(res, 200, { ok: true, connected: info?.connected || false, error: info?.error || null });
    }

    // ---- 知识库 ----
    if (p === '/api/knowledge' && method === 'POST') {
      const body = await readBody(req);
      state.knowledge = body.text || '';
      try { state.knowledgeObj = JSON.parse(state.knowledge); } catch (e) { state.knowledgeObj = null; }
      fs.writeFileSync(path.join(DATA_DIR, 'knowledge.json'), JSON.stringify({ text: state.knowledge }));
      return sendJSON(res, 200, { ok: true });
    }

    // ---- 重启 ----
    if (p === '/api/restart' && method === 'POST') {
      log('收到重启请求…');
      // 停止所有平台连接
      for (const [id] of state.platforms) {
        await disconnectPlatform(id);
      }
      // 重新初始化
      setTimeout(() => initPlatforms(), 1000);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- 未知路由 ----
    return sendJSON(res, 404, { error: 'not found', path: p });

  } catch (err) {
    log(`API 错误: ${err.message}`);
    return sendJSON(res, 500, { error: err.message });
  }
}

// ========== 平台连接管理 ==========
async function connectPlatform(platformId) {
  let info = state.platforms.get(platformId) || { connected: false, error: null, adapter: null };
  try {
    info.error = null;
    const adapter = PlatformAdapters.createAdapter(platformId, state.cdpManager);
    if (!adapter) throw new Error(`不支持的平台: ${platformId}`);
    await adapter.connect();
    info.adapter = adapter;
    info.connected = true;
    state.platforms.set(platformId, info);
    log(`平台 ${platformId} 已连接`);
  } catch (err) {
    info.connected = false;
    info.error = err.message;
    state.platforms.set(platformId, info);
    log(`平台 ${platformId} 连接失败: ${err.message}`);
  }
}

async function disconnectPlatform(platformId) {
  const info = state.platforms.get(platformId);
  if (info?.adapter) {
    try { await info.adapter.disconnect(); } catch (e) { /* ignore */ }
  }
  state.platforms.set(platformId, { connected: false, error: null, adapter: null });
  log(`平台 ${platformId} 已断开`);
}

function initPlatforms() {
  // 初始化所有平台为未连接状态
  for (const id of ['qianniu', 'douyin', 'pdd', 'jd', 'kuaishou', 'xhs']) {
    if (!state.platforms.has(id)) {
      state.platforms.set(id, { connected: false, error: null, adapter: null });
    }
  }
}

// ========== 消息轮询 ==========
async function pollMessages() {
  for (const [platId, info] of state.platforms) {
    if (!info.connected || !info.adapter) continue;
    try {
      const newMessages = await info.adapter.fetchNewMessages();
      for (const msg of newMessages) {
        // 找到或创建会话
        let conv = state.conversations.get(msg.convId);
        if (!conv) {
          conv = {
            id: msg.convId,
            platform: platId,
            buyerName: msg.buyerName || '买家',
            unread: 0,
            messages: [],
          };
          state.conversations.set(msg.convId, conv);
        }
        // 检查是否已存在（去重）
        const exists = conv.messages.some(m =>
          m.from === msg.from && m.content === msg.content && Math.abs(m.timestamp - msg.timestamp) < 5000
        );
        if (!exists) {
          conv.messages.push({
            from: msg.from,
            content: msg.content,
            timestamp: msg.timestamp,
          });
          if (msg.from === 'buyer') {
            conv.unread++;
            // 自动回复
            if (state.autoReply) {
              await handleAutoReply(conv);
            }
          }
        }
      }
    } catch (err) {
      // 静默处理轮询错误，避免刷屏
      if (err.message !== 'target not connected') {
        log(`轮询 ${platId} 出错: ${err.message}`);
      }
    }
  }
}

// ========== 自动回复 ==========
async function handleAutoReply(conv) {
  try {
    // 自动回复模式下，由服务直接生成一条预设回复
    // 注意：复杂的 AI 生成需要通过 UI → ai.generate 桥接（需用户确认）
    // 这里先做一个简单的知识库匹配 + 默认回复的降级方案
    const lastBuyerMsg = [...conv.messages].reverse().find(m => m.from === 'buyer');
    if (!lastBuyerMsg) return;

    let reply = '';

    // 尝试从知识库匹配
    if (state.knowledgeObj?.qa) {
      for (const qa of state.knowledgeObj.qa) {
        if (lastBuyerMsg.content.includes(qa.q)) {
          reply = qa.a;
          break;
        }
      }
    }

    // 未匹配到则使用默认回复
    if (!reply) {
      reply = '您好，您的消息已收到，客服正在处理中，请稍候~';
    }

    // 发送回复
    const adapter = state.platforms.get(conv.platform)?.adapter;
    if (adapter) {
      await adapter.sendMessage(conv, reply);
      conv.messages.push({
        from: 'agent',
        content: reply,
        timestamp: Date.now(),
        aiGenerated: false,
      });
      log(`自动回复 → ${conv.buyerName}: ${reply.substring(0, 50)}`);
    }
  } catch (err) {
    log(`自动回复失败: ${err.message}`);
  }
}

// ========== 日志 ==========
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  // 同时写入日志文件
  try {
    const logFile = path.join(DATA_DIR, 'service.log');
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) { /* ignore */ }
}

// ========== 启动 ==========
async function start() {
  ensureDataDir();
  loadKnowledge();

  // 生成随机 token
  state.token = crypto.randomBytes(24).toString('hex');

  // 将 token 写入一个文件供 UI 读取（UI 通过 plugin.storage 读取不到直接值，
  // 但可以通过宿主桥接 plugin.storage.read 读取这个文件路径的内容）
  const tokenFile = path.join(DATA_DIR, 'service-token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: state.token }));

  // 加载设置
  const port = loadSettings();

  // 初始化 CDP 管理器
  state.cdpManager = new CDPManager({
    port: state.settings.cdpPort || 9222,
  });

  // 初始化平台
  initPlatforms();

  // 启动 HTTP 服务
  state.server = http.createServer(handleRequest);
  state.server.listen(port, '127.0.0.1', () => {
    log(`服务已启动 → http://127.0.0.1:${port}`);
    log(`Token: ${state.token.substring(0, 8)}...`);
    log(`数据目录: ${DATA_DIR}`);
    log(`CDP 端口: ${state.settings.cdpPort || 9222}`);
    log('等待用户通过 UI 连接平台…');
  });

  state.server.on('error', (err) => {
    log(`HTTP 服务错误: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log(`端口 ${port} 被占用，尝试 ${port + 1}`);
      state.server.listen(port + 1, '127.0.0.1');
    }
  });

  // 启动消息轮询
  setInterval(pollMessages, POLL_INTERVAL);

  // 优雅退出
  process.on('SIGTERM', () => {
    log('收到 SIGTERM，正在关闭…');
    for (const [id] of state.platforms) {
      disconnectPlatform(id);
    }
    state.server.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('收到 SIGINT，正在关闭…');
    process.exit(0);
  });
}

start().catch(err => {
  log(`启动失败: ${err.message}`);
  process.exit(1);
});
