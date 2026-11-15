/**
 * 电商客服自动对话助手 — UI 主逻辑
 * 基于 ChatGPT-On-CS（AGPL-3.0）思路改写
 *
 * 架构：
 *   iframe UI（本文件）
 *     ├─ postMessage 桥接 → Code Worker 宿主（ai.generate / plugin.storage / app.notification）
 *     └─ fetch localhost → 后台 service.exe（CDP 挂接 / 消息收发 / 平台管理）
 */

// ========== 宿主桥接 ==========
function callHost(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMessage = (event) => {
      if (event.source !== window.parent) return;
      const msg = event.data;
      if (msg?.channel !== "codeworker-plugin" || msg.type !== "response" || msg.id !== id) return;
      window.removeEventListener("message", onMessage);
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "宿主 API 调用失败"));
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      channel: "codeworker-plugin",
      type: "request",
      id,
      method,
      params,
    }, "*");
  });
}

// ========== 状态 ==========
let settings = null;
let serviceBaseUrl = null;
let serviceToken = null;
let currentConvId = null;
let conversations = [];
let pollTimer = null;

// ========== 工具函数 ==========
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
}

async function getSettings() {
  const val = await callHost("plugin.storage.read", { key: "settings" });
  return val || {};
}

async function saveSettings(value) {
  await callHost("plugin.storage.write", { key: "settings", value });
}

// 初始化 service 连接信息
async function initServiceConnection() {
  const s = await getSettings();
  settings = s;
  const port = s.servicePort || 17389;
  serviceBaseUrl = `http://127.0.0.1:${port}`;
  // token 由 service 启动时写入插件存储，UI 读取后用于 API 认证
  const tokenData = await callHost("plugin.storage.read", { key: "service-token" });
  serviceToken = tokenData?.token || null;
}

// 调用后台 service 的本地 API
async function callService(path, options = {}) {
  if (!serviceBaseUrl) throw new Error("服务地址未初始化");
  const headers = { "Content-Type": "application/json" };
  if (serviceToken) headers["X-Plugin-Token"] = serviceToken;
  const resp = await fetch(`${serviceBaseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`服务请求失败 (${resp.status}): ${text}`);
  }
  return resp.json();
}

// ========== Tab 切换 ==========
function initTabs() {
  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      $$(".tab").forEach(t => t.classList.toggle("active", t === tab));
      $$(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${target}`));
      if (target === "inbox") startPolling();
      else stopPolling();
      if (target === "platforms") renderPlatforms();
    });
  });
}

// ========== 收件箱 ==========
async function fetchConversations() {
  try {
    const data = await callService("/api/conversations");
    conversations = data.conversations || [];
    renderConversationList();
    updateServiceStatus(true);
  } catch (e) {
    updateServiceStatus(false);
  }
}

function renderConversationList() {
  const list = $("#conversation-list");
  const keyword = $("#inbox-search-input")?.value?.trim()?.toLowerCase() || "";
  const filtered = keyword
    ? conversations.filter(c =>
        c.buyerName?.toLowerCase().includes(keyword) ||
        c.lastMessage?.toLowerCase().includes(keyword))
    : conversations;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无会话</div>';
    return;
  }

  list.innerHTML = filtered.map(c => `
    <div class="conv-item ${c.id === currentConvId ? "active" : ""}" data-conv-id="${c.id}">
      <div class="conv-name">${esc(c.buyerName || "未知买家")}</div>
      <div class="conv-preview">${esc(c.lastMessage || "")}</div>
      <div class="conv-meta">
        <span class="conv-time">${fmtTime(c.lastTime)}</span>
        ${c.unread > 0 ? `<span class="conv-unread">${c.unread}</span>` : ""}
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".conv-item").forEach(el => {
    el.addEventListener("click", () => selectConversation(el.dataset.convId));
  });
}

async function selectConversation(convId) {
  currentConvId = convId;
  renderConversationList();
  try {
    const data = await callService(`/api/conversations/${convId}/messages`);
    renderMessages(data.messages || [], convId);
    $("#reply-text").disabled = false;
    $("#btn-send").disabled = false;
    $("#btn-ai-draft").disabled = false;
    const conv = conversations.find(c => c.id === convId);
    if (conv) {
      $(".conv-title").textContent = conv.buyerName || "未知买家";
      $("#conv-platform").textContent = conv.platform || "";
      $("#conv-platform").className = `badge ${conv.platform ? "badge-info" : ""}`;
    }
  } catch (e) {
    showMessageListError(e.message);
  }
}

function renderMessages(messages, convId) {
  const list = $("#message-list");
  if (messages.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无消息</div>';
    return;
  }
  list.innerHTML = messages.map(m => {
    const cls = m.from === "buyer" ? "msg-buyer" : m.from === "system" ? "msg-system" : "msg-agent";
    return `<div class="msg ${cls}">
      <div class="msg-content">${esc(m.content || "")}</div>
      <div class="msg-meta">${fmtTime(m.timestamp)}${m.from === "agent" && m.aiGenerated ? " · AI" : ""}</div>
    </div>`;
  }).join("");
  list.scrollTop = list.scrollHeight;
}

function showMessageListError(err) {
  $("#message-list").innerHTML = `<div class="empty-hint">加载失败: ${esc(err)}</div>`;
}

// ========== AI 起草 ==========
$("#btn-ai-draft")?.addEventListener("click", async () => {
  if (!currentConvId) return;
  const conv = conversations.find(c => c.id === currentConvId);
  if (!conv) return;

  const btn = $("#btn-ai-draft");
  btn.disabled = true;
  btn.textContent = "生成中…";

  try {
    // 获取最近消息作为上下文
    const msgData = await callService(`/api/conversations/${currentConvId}/messages`);
    const recentMsgs = (msgData.messages || []).slice(-10);

    // 构造 prompt 给 Code Worker AI
    const contextParts = recentMsgs.map(m =>
      `${m.from === "buyer" ? "买家" : "客服"}: ${m.content}`
    ).join("\n");

    const knowledgeText = await getKnowledgeText();
    const styleMap = { friendly: "友好亲切", professional: "专业正式", concise: "简洁高效" };
    const style = styleMap[settings?.replyStyle] || "友好亲切";

    const prompt = [
      `你是一个电商客服助手，请根据以下对话上下文生成一条回复。`,
      `回复风格：${style}`,
      knowledgeText ? `\n参考知识库：\n${knowledgeText}` : "",
      `\n对话上下文：\n${contextParts}`,
      `\n请直接输出回复内容，不要加解释。回复不超过200字。`,
    ].join("");

    const result = await callHost("ai.generate", {
      title: `客服回复 · ${conv.buyerName}`,
      prompt,
    });

    if (result?.text) {
      $("#reply-text").value = result.text.trim();
    }
  } catch (e) {
    await callHost("app.notification.show", { title: "AI 起草失败", body: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI 起草";
  }
});

// ========== 发送回复 ==========
$("#btn-send")?.addEventListener("click", async () => {
  if (!currentConvId) return;
  const text = $("#reply-text").value.trim();
  if (!text) return;

  const btn = $("#btn-send");
  btn.disabled = true;

  try {
    await callService(`/api/conversations/${currentConvId}/reply`, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });
    $("#reply-text").value = "";
    await callHost("app.notification.show", { title: "已发送", body: "回复已发送到平台" });
    // 刷新消息
    await selectConversation(currentConvId);
  } catch (e) {
    await callHost("app.notification.show", { title: "发送失败", body: e.message });
  } finally {
    btn.disabled = false;
  }
});

// ========== 自动回复开关 ==========
$("#auto-reply-toggle")?.addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  try {
    await callService("/api/auto-reply", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    await callHost("app.notification.show", {
      title: enabled ? "自动回复已开启" : "自动回复已关闭",
      body: enabled ? "收到买家消息后将自动调用 AI 生成并发送回复" : "需手动发送回复",
    });
  } catch (err) {
    e.target.checked = !enabled;
    await callHost("app.notification.show", { title: "操作失败", body: err.message });
  }
});

// ========== 平台管理 ==========
const PLATFORMS = [
  { id: "qianniu", name: "千牛（淘宝/天猫）", desc: "挂接千牛工作台 WebView", icon: "🛒" },
  { id: "douyin", name: "抖店（飞鸽）", desc: "挂接抖店飞鸽客服客户端", icon: "🎵" },
  { id: "pdd", name: "拼多多商家版", desc: "挂接拼多多商家客服客户端", icon: "📋" },
  { id: "jd", name: "京东（京麦/咚咚）", desc: "挂接京麦客服客户端", icon: "📦" },
  { id: "kuaishou", name: "快手小店", desc: "挂接快手小店客服客户端", icon: "⚡" },
  { id: "xhs", name: "小红书商家", desc: "挂接小红书商家后台客服", icon: "📕" },
];

async function renderPlatforms() {
  const list = $("#platform-list");
  let statuses = {};
  try {
    const data = await callService("/api/platforms/status");
    statuses = data.statuses || {};
  } catch (e) {
    // 服务未连接
  }

  list.innerHTML = PLATFORMS.map(p => {
    const st = statuses[p.id];
    const connected = st?.connected;
    const badgeCls = connected ? "badge-on" : "badge-off";
    const badgeText = connected ? "已连接" : "未连接";
    return `
      <div class="platform-card">
        <div class="pc-header">
          <span class="pc-name">${p.icon} ${p.name}</span>
          <span class="pc-status badge ${badgeCls}">${badgeText}</span>
        </div>
        <div class="pc-info">${p.desc}</div>
        ${st?.error ? `<div class="pc-info" style="color:var(--danger)">${esc(st.error)}</div>` : ""}
        <div class="pc-actions">
          <button class="btn btn-sm" data-action="connect" data-platform="${p.id}">连接</button>
          <button class="btn btn-sm" data-action="disconnect" data-platform="${p.id}">断开</button>
        </div>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const platform = btn.dataset.platform;
      btn.disabled = true;
      try {
        await callService(`/api/platforms/${platform}/${action}`, { method: "POST" });
        await renderPlatforms();
        await callHost("app.notification.show", {
          title: action === "connect" ? "连接请求已发送" : "已断开",
          body: `${PLATFORMS.find(p => p.id === platform)?.name}`,
        });
      } catch (e) {
        await callHost("app.notification.show", { title: "操作失败", body: e.message });
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ========== 知识库 ==========
async function getKnowledgeText() {
  const val = await callHost("plugin.storage.read", { key: "knowledge" });
  if (val?.text) return val.text;
  if (typeof val === "string") return val;
  return "";
}

async function loadKnowledge() {
  const text = await getKnowledgeText();
  $("#knowledge-text").value = text;
}

$("#btn-save-knowledge")?.addEventListener("click", async () => {
  const text = $("#knowledge-text").value.trim();
  await callHost("plugin.storage.write", { key: "knowledge", value: { text } });
  // 同步到 service
  try {
    await callService("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  } catch (e) { /* 服务未连接时静默 */ }
  await callHost("app.notification.show", { title: "已保存", body: "知识库已更新" });
});

$("#btn-add-qa")?.addEventListener("click", () => {
  const ta = $("#knowledge-text");
  const template = '\n{"q": "问题", "a": "回答"},';
  const pos = ta.selectionStart;
  ta.value = ta.value.slice(0, pos) + template + ta.value.slice(pos);
  ta.focus();
});

// ========== 设置 ==========
async function loadSettingsUI() {
  const s = settings || await getSettings();
  $("#setting-style").value = s.replyStyle || "friendly";
  $("#setting-delay").value = s.autoReplyDelay ?? 3;
  $("#setting-cdp-port").value = s.cdpPort || 9222;
  $("#setting-service-port").value = s.servicePort || 17389;
}

$("#btn-save-settings")?.addEventListener("click", async () => {
  const newSettings = {
    replyStyle: $("#setting-style").value,
    autoReplyDelay: parseInt($("#setting-delay").value) || 3,
    cdpPort: parseInt($("#setting-cdp-port").value) || 9222,
    servicePort: parseInt($("#setting-service-port").value) || 17389,
  };
  await saveSettings(newSettings);
  settings = newSettings;
  await callHost("app.notification.show", { title: "设置已保存", body: "部分设置需重启服务后生效" });
});

$("#btn-restart-service")?.addEventListener("click", async () => {
  try {
    await callService("/api/restart", { method: "POST" });
    await callHost("app.notification.show", { title: "重启中", body: "服务正在重启…" });
    setTimeout(() => initServiceConnection().then(() => fetchConversations()), 3000);
  } catch (e) {
    await callHost("app.notification.show", { title: "重启失败", body: e.message });
  }
});

// ========== 轮询 ==========
function startPolling() {
  stopPolling();
  fetchConversations();
  pollTimer = setInterval(fetchConversations, 5000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ========== 服务状态 ==========
function updateServiceStatus(connected) {
  const el = $("#service-status");
  if (connected) {
    el.textContent = "服务已连接";
    el.className = "badge badge-on";
  } else {
    el.textContent = "服务未连接";
    el.className = "badge badge-off";
  }
}

// ========== 辅助 ==========
function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

$("#btn-refresh")?.addEventListener("click", () => {
  initServiceConnection().then(() => {
    fetchConversations();
    const activeTab = $(".tab.active")?.dataset.tab;
    if (activeTab === "platforms") renderPlatforms();
  });
});

$("#inbox-search-input")?.addEventListener("input", () => renderConversationList());

// ========== 启动 ==========
async function main() {
  initTabs();
  await initServiceConnection();
  await loadSettingsUI();
  await loadKnowledge();
  startPolling();
}

main().catch(err => {
  console.error("初始化失败:", err);
  updateServiceStatus(false);
});
