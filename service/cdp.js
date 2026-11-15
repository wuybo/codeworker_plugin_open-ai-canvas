/**
 * CDP (Chrome DevTools Protocol) 管理器
 * 基于 ChatGPT-On-CS（AGPL-3.0）的 CDP 注入思路改写
 *
 * 原理：
 *   以 --remote-debugging-port 启动 Chrome/Edge，打开各平台网页版商家工作台，
 *   通过 CDP WebSocket 用 Runtime.evaluate 注入 JS 脚本读取聊天 DOM / 模拟输入发送消息。
 *
 * 通信方式：WebSocket（Node >= 21 内置 global WebSocket，零依赖）。
 *
 * 许可证：AGPL-3.0
 */

'use strict';

const http = require('http');

// Node 22 内置 WebSocket（undici 实现）；若运行环境缺失则给出明确错误
const WS = typeof WebSocket !== 'undefined' ? WebSocket : null;

class CDPManager {
  constructor(options = {}) {
    this.defaultPort = options.port || 9222;
  }

  /**
   * 通用 HTTP GET（JSON）
   */
  _httpJson(port, pathStr) {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: pathStr,
        headers: { Host: `127.0.0.1:${port}` },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`CDP ${pathStr} 解析失败: ${e.message}`)); }
        });
      });
      req.on('error', (e) => reject(new Error(`无法连接 CDP 端口 ${port}: ${e.message}`)));
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('CDP 连接超时')); });
    });
  }

  /**
   * 发现指定端口上的 CDP 调试目标
   */
  async discoverTargets(port) {
    return this._httpJson(port || this.defaultPort, '/json');
  }

  /**
   * 查找匹配 URL/标题的目标
   */
  async findTarget(filter, port) {
    const targets = await this.discoverTargets(port);
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
   * 检查指定端口 CDP 是否可用
   */
  async isAvailable(port) {
    try {
      await this._httpJson(port || this.defaultPort, '/json/version');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 在目标页面（tab）上执行 JS 表达式并返回结果
   * 使用 CDP WebSocket + Runtime.evaluate
   *
   * @param {object} target - /json 返回的 target 对象（含 webSocketDebuggerUrl）
   * @param {string} expression - JS 表达式
   * @param {number} timeoutMs - 超时
   * @returns {Promise<any>} - 求值结果（returnByValue）
   */
  evaluateOn(target, expression, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!WS) {
        reject(new Error('当前运行环境不支持 WebSocket（需要 Node >= 21）'));
        return;
      }
      if (!target || !target.webSocketDebuggerUrl) {
        reject(new Error('target 缺少 webSocketDebuggerUrl'));
        return;
      }

      // Chrome 返回的 URL 可能是 ws://localhost:{port}/… → undici 会解析到 IPv6 ::1 而连不上
      // 统一改写 host 为 127.0.0.1
      let wsUrl = target.webSocketDebuggerUrl;
      try {
        const u = new URL(wsUrl);
        if (u.hostname === 'localhost') {
          u.hostname = '127.0.0.1';
          wsUrl = u.toString();
        }
      } catch (e) { /* 保持原样 */ }
      const ws = new WS(wsUrl);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('CDP evaluate 超时')); }
      }, timeoutMs);

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        fn(arg);
      };

      ws.addEventListener('error', () => finish(reject, new Error('CDP WebSocket 连接失败')));
      ws.addEventListener('close', () => finish(reject, new Error('CDP WebSocket 已关闭')));

      ws.addEventListener('open', () => {
        try {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression,
              returnByValue: true,
              awaitPromise: true,
              timeout: timeoutMs - 500,
            },
          }));
        } catch (e) {
          finish(reject, e);
        }
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.id !== 1) return;
        if (msg.error) {
          finish(reject, new Error(msg.error.message || 'CDP evaluate 失败'));
          return;
        }
        const r = msg.result;
        if (r && r.exceptionDetails) {
          finish(reject, new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || '页面脚本执行异常'));
          return;
        }
        finish(resolve, r && r.result ? r.result.value : undefined);
      });
    });
  }

  /**
   * 兼容旧接口：注入脚本执行
   */
  async injectScript(target, script) {
    return this.evaluateOn(target, script);
  }

  /**
   * 关闭所有会话（每次 evaluate 用完即断，无需清理）
   */
  async closeAll() {
    // no-op
  }
}

module.exports = { CDPManager };
