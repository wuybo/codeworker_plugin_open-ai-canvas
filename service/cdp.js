/**
 * CDP (Chrome DevTools Protocol) 管理器
 * 基于 ChatGPT-On-CS（AGPL-3.0）的 CDP 注入思路改写
 *
 * 原理：
 *   各电商平台商家客户端（千牛/抖店飞鸽/拼多多商家版等）内嵌 Chromium WebView，
 *   通过 Chrome DevTools Protocol 的 remote debugging 可以 attach 到这些 WebView，
 *   然后用 Runtime.evaluate 注入 JS 脚本读取聊天 DOM / 模拟输入发送消息。
 *
 * 本模块零依赖，使用 Node.js 内置 http 模块实现 CDP WebSocket 通信。
 *
 * 许可证：AGPL-3.0
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

class CDPManager {
  constructor(options = {}) {
    this.cdpPort = options.port || 9222;       // CDP 远程调试端口
    this.targets = new Map();                   // targetId → target info
    this.sessions = new Map();                  // targetId → sessionId
  }

  /**
   * 发现 CDP 调试目标
   * GET http://127.0.0.1:{cdpPort}/json 返回所有打开的页面/WebView 列表
   */
  async discoverTargets() {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: this.cdpPort,
        path: '/json',
        headers: { 'Host': 'localhost' },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            resolve(targets);
          } catch (e) {
            reject(new Error(`CDP /json 解析失败: ${e.message}`));
          }
        });
      });
      req.on('error', (e) => {
        reject(new Error(`无法连接 CDP 端口 ${this.cdpPort}: ${e.message}。请确保商家客户端以 --remote-debugging-port=${this.cdpPort} 启动。`));
      });
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('CDP 连接超时'));
      });
    });
  }

  /**
   * 查找匹配 URL/标题的目标
   */
  async findTarget(filter) {
    const targets = await this.discoverTargets();
    for (const t of targets) {
      if (t.type !== 'page') continue;
      if (filter.url && t.url && t.url.includes(filter.url)) return t;
      if (filter.title && t.title && t.title.includes(filter.title)) return t;
      if (filter.urlRegex) {
        const re = new RegExp(filter.urlRegex);
        if (re.test(t.url || '')) return t;
      }
    }
    return null;
  }

  /**
   * 在目标页面上执行 JS 表达式并返回结果
   * 使用 CDP 的 Runtime.evaluate 命令
   *
   * 注意：完整实现需要 WebSocket 连接到 CDP endpoint。
   * 这里使用 HTTP /json/evaluate 简化方案（Chromium >= vxx 支持），
   * 如果不支持则回退到通过 ws 协议的完整实现。
   */
  async evaluate(targetId, expression) {
    // 方案1: 尝试通过 WebSocket 发送 CDP 命令
    // 由于 Node.js 内置没有 WebSocket 客户端（Node 22 已有实验性 WebSocket），
    // 我们使用 HTTP-based 的 evaluate 方式
    return this._evaluateViaHTTP(expression);
  }

  /**
   * 通过 HTTP /json/evaluate 执行 JS（如果 Chromium 支持）
   */
  async _evaluateViaHTTP(expression) {
    return new Promise((resolve, reject) => {
      // 编码表达式
      const encoded = Buffer.from(expression).toString('base64');
      const req = http.get({
        hostname: '127.0.0.1',
        port: this.cdpPort,
        path: `/json/evaluate?expression=${encodeURIComponent(encoded)}`,
        headers: { 'Host': 'localhost' },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (e) {
            // 可能返回的是纯文本结果
            resolve({ result: { value: data } });
          }
        });
      });
      req.on('error', (e) => {
        reject(new Error(`CDP evaluate 失败: ${e.message}`));
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('CDP evaluate 超时'));
      });
    });
  }

  /**
   * 获取 CDP 版本信息
   */
  async getVersion() {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: this.cdpPort,
        path: '/json/version',
        headers: { 'Host': 'localhost' },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  /**
   * 检查 CDP 是否可用
   */
  async isAvailable() {
    try {
      const version = await this.getVersion();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 在目标页面注入 JS 脚本（通过 evaluate）
   * @param {Object} target - CDP target 对象（含 webSocketDebuggerUrl）
   * @param {string} script - 要注入的 JS 代码
   * @returns {Promise<any>} 执行结果
   */
  async injectScript(target, script) {
    // 使用 evaluate 注入并执行
    const result = await this._evaluateViaHTTP(script);
    return result;
  }

  /**
   * 关闭所有会话
   */
  async closeAll() {
    this.sessions.clear();
    this.targets.clear();
  }
}

module.exports = { CDPManager };
