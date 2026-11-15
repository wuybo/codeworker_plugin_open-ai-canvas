/**
 * 平台适配器集合
 * 基于 ChatGPT-On-CS（AGPL-3.0）的 per-platform driver 思路改写
 *
 * 每个适配器负责：
 *   1. 通过 CDP 发现并 attach 到对应平台商家客户端的聊天 WebView
 *   2. 注入 JS 脚本读取买家消息（DOM 选择器）
 *   3. 注入 JS 脚本模拟输入并发送回复
 *
 * 注意：各平台客户端 WebView 的 DOM 结构会随版本更新而变化，
 * 选择器需要持续维护。这里给出框架和初始选择器模板。
 *
 * 许可证：AGPL-3.0
 */

'use strict';

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
   * 连接：发现目标 WebView
   */
  async connect() {
    const cdpOk = await this.cdp.isAvailable();
    if (!cdpOk) {
      throw new Error(`CDP 端口 ${this.cdp.cdpPort} 不可用。请以 --remote-debugging-port=${this.cdp.cdpPort} 启动${this.platformName}客户端。`);
    }

    this.target = await this.cdp.findTarget(this.targetFilter);
    if (!this.target) {
      throw new Error(`未找到${this.platformName}聊天页面。请确保${this.platformName}客户端已打开并进入客服聊天窗口。`);
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
   * 获取新消息
   * @returns {Promise<Array<{convId, from, content, timestamp, buyerName}>>}
   */
  async fetchNewMessages() {
    if (!this.connected || !this.target) return [];
    try {
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
      if (e.message.includes('target')) throw e;
      return [];
    }
  }

  /**
   * 发送消息
   */
  async sendMessage(conv, content) {
    if (!this.connected || !this.target) {
      throw new Error(`${this.platformName}未连接`);
    }
    const script = this.buildSendScript(content);
    await this.cdp.injectScript(this.target, script);
  }

  // 子类覆盖
  get platformName() { return this.platformId; }
  get targetFilter() { return {}; }

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

  get targetFilter() {
    return { urlRegex: 'qianniu|taobao|tmall|workbench' };
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

  get targetFilter() {
    return { urlRegex: 'feige|douyin|jinritemai|im' };
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

  get targetFilter() {
    return { urlRegex: 'pinduoduo|pdd|mms' };
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

  get targetFilter() {
    return { urlRegex: 'jd|jingdong|dongdong|jmes' };
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

  get targetFilter() {
    return { urlRegex: 'kuaishou|ks|kwai' };
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

  get targetFilter() {
    return { urlRegex: 'xiaohongshu|xhs|ark' };
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
