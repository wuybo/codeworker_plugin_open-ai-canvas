/**
 * 平台适配器集合
 * 基于 ChatGPT-On-CS（AGPL-3.0）的 per-platform driver 思路改写
 *
 * 每个适配器负责：
 *   1. 通过 CDP 发现并 attach 到对应平台商家客户端的聊天 WebView
 *   2. 注入 JS 脚本读取买家消息（DOM 选择器）
 *   3. 注入 JS 脚本模拟输入并发送回复
 *   4. smartConnect: 自动启动浏览器/打开/激活客服页面
 *
 * 注意：各平台客户端 WebView 的 DOM 结构会随版本更新而变化，
 * 选择器需要持续维护。这里给出框架和初始选择器模板。
 *
 * 许可证：AGPL-3.0
 */

'use strict';

const { smartConnect, checkCdpPort, findTab, activateTab, openTab } = require('./browser-launcher');
const path = require('path');

/**
 * 基础平台适配器
 */
class BaseAdapter {
  constructor(platformId, cdpManager) {
    this.platformId = platformId;
    this.cdp = cdpManager;
    this.target = null;
    this.lastMsgTime = 0;
    this.connected = false;
  }

  /**
   * 每个平台一个独立调试端口（基础端口 + 平台偏移），
   * 独立 profile 目录 → 各平台登录态互不干扰，可多平台同时挂接。
   */
  get portOffset() { return 0; }
  get debugPort() { return (this.cdp.defaultPort || 9222) + this.portOffset; }

  /**
   * 连接：智能启动浏览器 → 打开/激活客服页面 → attach
   *
   * 流程：
   *   1. 检查该平台专属 CDP 端口是否可用
   *   2. 不可用 → 自动启动 Chrome/Edge 独立实例（专属端口+专属 profile+目标URL）
   *   3. 可用后 → 查找是否已打开目标平台页面
   *   4. 没打开 → 自动打开新标签页
   *   5. 已打开 → 激活置顶
   *   6. attach 到目标
   */
  async connect() {
    // 智能连接：自动启动浏览器 + 打开/激活页面
    const result = await smartConnect({
      cdpPort: this.debugPort,
      platformUrl: this.platformUrl,
      targetFilter: this.targetFilter,
      profileDir: this.profileDir,
    });

    if (!result.ok) {
      throw new Error(result.error || `${this.platformName}连接失败`);
    }

    // smartConnect 已经找到/打开了目标页面
    this.target = result.tab;
    if (!this.target) {
      // 回退：端口已就绪，用 CDP 再查一次
      this.target = await this.cdp.findTarget(this.targetFilter, this.debugPort);
    }

    if (!this.target) {
      throw new Error(`未找到${this.platformName}聊天页面，请在打开的浏览器中进入客服工作台后重试。`);
    }

    this.connected = true;
  }

  /**
   * 断开
   */
  async disconnect() {
    this.target = null;
    this.connected = false;
  }

  /**
   * 刷新 target（页面刷新后旧 webSocketDebuggerUrl 会失效）
   */
  async ensureTarget() {
    const fresh = await this.cdp.findTarget(this.targetFilter, this.debugPort);
    if (fresh) this.target = fresh;
    return this.target;
  }

  /**
   * 获取新消息
   * @returns {Promise<Array<{convId, from, content, timestamp, buyerName}>>}
   */
  async fetchNewMessages() {
    if (!this.connected) return [];
    try {
      await this.ensureTarget();
      if (!this.target) {
        this.connected = false;
        throw new Error('target not connected');
      }
      const script = this.buildFetchScript();
      const result = await this.cdp.injectScript(this.target, script);
      const messages = this.parseFetchResult(result);
      // 过滤已读过的消息
      const newMsgs = messages.filter(m => m.timestamp > this.lastMsgTime);
      if (newMsgs.length > 0) {
        this.lastMsgTime = newMsgs[newMsgs.length - 1].timestamp;
      }
      return newMsgs;
    } catch (e) {
      if (e.message === 'target not connected') throw e;
      return [];
    }
  }

  /**
   * 发送消息
   */
  async sendMessage(conv, content) {
    if (!this.connected) {
      throw new Error(`${this.platformName}未连接`);
    }
    await this.ensureTarget();
    if (!this.target) {
      throw new Error(`${this.platformName}聊天页面未找到，请确认页面已打开`);
    }
    const script = this.buildSendScript(content);
    await this.cdp.injectScript(this.target, script);
  }

  // 子类覆盖
  get platformName() { return this.platformId; }
  get targetFilter() { return {}; }
  get platformUrl() { return null; }     // 各平台网页版客服 URL
  get profileDir() { return null; }       // 独立浏览器 profile 目录

  /**
   * 构建读取消息的 JS 脚本
   * 子类需覆盖
   */
  buildFetchScript() {
    return '(function(){ return JSON.stringify([]); })()';
  }

  /**
   * 构建发送消息的 JS 脚本
   * 子类需覆盖
   */
  buildSendScript(content) {
    return '(function(){ return "ok"; })()';
  }

  /**
   * 解析读取结果
   */
  parseFetchResult(result) {
    if (!result) return [];
    let str = result;
    if (typeof result === 'object') {
      str = result.result?.value || JSON.stringify(result);
    }
    try {
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 转义 JS 字符串内容
   */
  escapeJs(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }
}

// ========== 千牛（淘宝/天猫）==========
class QianniuAdapter extends BaseAdapter {
  get platformName() { return '千牛'; }
  get portOffset() { return 0; }

  get targetFilter() {
    return { urlRegex: 'work\\.taobao|qianniu|wangwang' };
  }

  get platformUrl() {
    return 'https://work.taobao.com/';  // 千牛网页版客服工作台
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-qianniu');
  }

  buildFetchScript() {
    // 千牛聊天窗口的 DOM 选择器（需根据实际版本调整）
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('.chat-message, .msg-item, [class*="message"]');
        items.forEach(function(item, idx) {
          var fromEl = item.querySelector('.sender, .from, [class*="sender"]');
          var contentEl = item.querySelector('.content, .text, [class*="content"]');
          var isBuyer = item.className.indexOf('buyer') >= 0 || item.className.indexOf('left') >= 0;
          msgs.push({
            convId: 'qn_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: document.querySelector('.buyer-name, .user-name, [class*="buyer"]')?.innerText?.trim() || '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('.chat-input, .reply-input, textarea[class*="input"], [contenteditable="true"]');
        if (input) {
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new Event('change', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('.send-btn, [class*="send"], button[class*="submit"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 抖店飞鸽 ==========
class DouyinAdapter extends BaseAdapter {
  get platformName() { return '抖店飞鸽'; }
  get portOffset() { return 1; }

  get targetFilter() {
    return { urlRegex: 'feige|jinritemai' };
  }

  get platformUrl() {
    return 'https://im.jinritemai.com/pc_seller_v2/main/workspace';  // 飞鸽网页版
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-douyin');
  }

  buildFetchScript() {
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('[class*="message-item"], [class*="msg-item"], .chat-item');
        items.forEach(function(item, idx) {
          var isBuyer = item.className.indexOf('left') >= 0 || item.className.indexOf('buyer') >= 0;
          var contentEl = item.querySelector('[class*="text"], [class*="content"], .bubble');
          msgs.push({
            convId: 'dy_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: document.querySelector('[class*="user-name"], [class*="nickname"]')?.innerText?.trim() || '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('[class*="input-area"] textarea, [class*="reply"] [contenteditable], [class*="input"] [contenteditable]');
        if (input) {
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('[class*="send"], [class*="submit"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 拼多多 ==========
class PddAdapter extends BaseAdapter {
  get platformName() { return '拼多多'; }
  get portOffset() { return 2; }

  get targetFilter() {
    return { urlRegex: 'mms\\.pinduoduo|pddchat|yangkeduo' };
  }

  get platformUrl() {
    return 'https://mms.pinduoduo.com/chat/index';  // 拼多多商家客服网页版
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-pdd');
  }

  buildFetchScript() {
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('[class*="chat-msg"], [class*="message"], .msg-item');
        items.forEach(function(item, idx) {
          var isBuyer = item.className.indexOf('left') >= 0 || item.className.indexOf('buyer') >= 0;
          var contentEl = item.querySelector('[class*="content"], [class*="text"]');
          msgs.push({
            convId: 'pdd_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: document.querySelector('[class*="user"], [class*="buyer-name"]')?.innerText?.trim() || '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('[class*="input"] textarea, [contenteditable="true"]');
        if (input) {
          if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('[class*="send"], [class*="btn-send"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 京东（京麦/咚咚）==========
class JdAdapter extends BaseAdapter {
  get platformName() { return '京东咚咚'; }
  get portOffset() { return 3; }

  get targetFilter() {
    return { urlRegex: 'jdwshop|shop\\.jd|dongdong|jmcm|jingmai' };
  }

  get platformUrl() {
    return 'https://jmw.jd.cn/';  // 京麦工作台（含咚咚客服）
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-jd');
  }

  buildFetchScript() {
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('[class*="msg"], [class*="chat-item"], .message');
        items.forEach(function(item, idx) {
          var isBuyer = item.className.indexOf('left') >= 0;
          var contentEl = item.querySelector('[class*="text"], [class*="content"]');
          msgs.push({
            convId: 'jd_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('textarea, [contenteditable="true"]');
        if (input) {
          if (input.tagName === 'TEXTAREA') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('[class*="send"], [class*="submit"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 快手小店 ==========
class KuaishouAdapter extends BaseAdapter {
  get platformName() { return '快手小店'; }
  get portOffset() { return 4; }

  get targetFilter() {
    return { urlRegex: 'kwaixiaodian|im\\.kwaixiaodian' };
  }

  get platformUrl() {
    return 'https://im.kwaixiaodian.com/';  // 快手小店客服
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-kuaishou');
  }

  buildFetchScript() {
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('[class*="msg"], [class*="chat"], .message-item');
        items.forEach(function(item, idx) {
          var isBuyer = item.className.indexOf('left') >= 0;
          var contentEl = item.querySelector('[class*="text"], [class*="content"]');
          msgs.push({
            convId: 'ks_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('textarea, [contenteditable="true"]');
        if (input) {
          if (input.tagName === 'TEXTAREA') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('[class*="send"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 小红书 ==========
class XhsAdapter extends BaseAdapter {
  get platformName() { return '小红书'; }
  get portOffset() { return 5; }

  get targetFilter() {
    return { urlRegex: 'xiaohongshu|qian\\.xiaohongshu' };
  }

  get platformUrl() {
    return 'https://qian.xiaohongshu.com/';  // 小红书千帆商家后台
  }

  get profileDir() {
    return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-bot-xhs');
  }

  buildFetchScript() {
    return `(function(){
      try {
        var msgs = [];
        var items = document.querySelectorAll('[class*="msg"], [class*="chat"], .message');
        items.forEach(function(item, idx) {
          var isBuyer = item.className.indexOf('left') >= 0;
          var contentEl = item.querySelector('[class*="text"], [class*="content"]');
          msgs.push({
            convId: 'xhs_' + (document.title || 'default'),
            from: isBuyer ? 'buyer' : 'agent',
            content: contentEl ? contentEl.innerText.trim() : '',
            timestamp: Date.now() - (items.length - idx) * 1000,
            buyerName: '买家'
          });
        });
        return JSON.stringify(msgs);
      } catch(e) { return JSON.stringify([]); }
    })()`;
  }

  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return `(function(){
      try {
        var input = document.querySelector('textarea, [contenteditable="true"]');
        if (input) {
          if (input.tagName === 'TEXTAREA') {
            input.value = '${safe}';
            input.dispatchEvent(new Event('input', {bubbles:true}));
          } else {
            input.innerText = '${safe}';
            input.dispatchEvent(new InputEvent('input', {bubbles:true}));
          }
          var btn = document.querySelector('[class*="send"]');
          if (btn) btn.click();
          return 'ok';
        }
        return 'input not found';
      } catch(e) { return e.message; }
    })()`;
  }
}

// ========== 适配器工厂 ==========
const ADAPTER_MAP = {
  qianniu: QianniuAdapter,
  douyin: DouyinAdapter,
  pdd: PddAdapter,
  jd: JdAdapter,
  kuaishou: KuaishouAdapter,
  xhs: XhsAdapter,
};

function createAdapter(platformId, cdpManager) {
  const AdapterClass = ADAPTER_MAP[platformId];
  if (!AdapterClass) return null;
  return new AdapterClass(platformId, cdpManager);
}

function getSupportedPlatforms() {
  return Object.keys(ADAPTER_MAP);
}

module.exports = {
  BaseAdapter,
  QianniuAdapter,
  DouyinAdapter,
  PddAdapter,
  JdAdapter,
  KuaishouAdapter,
  XhsAdapter,
  PlatformAdapters: { createAdapter, getSupportedPlatforms },
};
