/**
 * 浏览器启动管理器
 *
 * 功能：
 *   1. 查找本机 Chrome / Edge 可执行文件路径
 *   2. 以 --remote-debugging-port 启动浏览器实例
 *   3. 通过 CDP /json/new 端点打开指定 URL（新标签页）
 *   4. 检测 CDP 端口是否可用
 *
 * 参考 Code Worker 的 browser_manager.rs 实现（相同的 Windows 路径和参数）。
 *
 * 许可证：AGPL-3.0
 */

'use strict';

const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Chrome / Edge 的候选安装路径
const BROWSER_PATHS = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ],
  edge: [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/**
 * 查找可用的浏览器可执行文件
 * @returns {{ browser: string, path: string } | null}
 */
function findBrowser() {
  // 优先 Chrome，其次 Edge
  for (const browser of ['chrome', 'edge']) {
    for (const p of BROWSER_PATHS[browser]) {
      if (p && fs.existsSync(p)) {
        return { browser, path: p };
      }
    }
  }
  // 尝试通过注册表查找
  try {
    const regChrome = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve 2>nul', { encoding: 'utf-8', timeout: 3000 });
    const match = regChrome.match(/REG_SZ\s+(.+)/);
    if (match) {
      const p = match[1].trim();
      if (fs.existsSync(p)) return { browser: 'chrome', path: p };
    }
  } catch (e) { /* ignore */ }

  try {
    const regEdge = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve 2>nul', { encoding: 'utf-8', timeout: 3000 });
    const match = regEdge.match(/REG_SZ\s+(.+)/);
    if (match) {
      const p = match[1].trim();
      if (fs.existsSync(p)) return { browser: 'edge', path: p };
    }
  } catch (e) { /* ignore */ }

  return null;
}

/**
 * 检测 CDP 端口是否可用
 */
function checkCdpPort(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/json/version',
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve({ available: true, info });
        } catch (e) {
          resolve({ available: false });
        }
      });
    });
    req.on('error', () => resolve({ available: false }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ available: false }); });
  });
}

/**
 * 启动带远程调试端口的浏览器
 * @param {number} port - CDP 调试端口
 * @param {string} [url] - 启动时打开的 URL
 * @param {string} [profileDir] - 用户数据目录（隔离 profile）
 * @returns {Promise<{ ok: boolean, browser: string, path: string, port: number, error?: string }>}
 */
async function launchBrowser(port, url, profileDir) {
  const browser = findBrowser();
  if (!browser) {
    return { ok: false, error: '未找到 Chrome 或 Edge 浏览器，请先安装。' };
  }

  // 检查端口是否已经在运行（已有浏览器实例）
  const existing = await checkCdpPort(port);
  if (existing.available) {
    return { ok: true, browser: browser.browser, path: browser.path, port, alreadyRunning: true };
  }

  // 构造启动参数
  const dataDir = profileDir || path.join(
    process.env.LOCALAPPDATA || process.env.APPDATA || '.',
    'ecom-cs-bot-browser-profile'
  );

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-plugins',
    '--remote-allow-origins=*',
    `--user-data-dir=${dataDir}`,
  ];

  if (url) {
    args.push(url);
  }

  // 启动进程
  try {
    const child = spawn(browser.path, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    // 等待 CDP 端口就绪（最多 10 秒）
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const check = await checkCdpPort(port);
      if (check.available) {
        return { ok: true, browser: browser.browser, path: browser.path, port };
      }
    }

    return { ok: false, error: '浏览器已启动但 CDP 端口未就绪（超时 10 秒）', browser: browser.browser, path: browser.path, port };
  } catch (err) {
    return { ok: false, error: `启动浏览器失败: ${err.message}`, browser: browser.browser, path: browser.path, port };
  }
}

/**
 * 通过 CDP 打开新标签页（导航到指定 URL）
 * 新版 Chrome 要求 PUT 方法访问 /json/new
 * @param {number} port - CDP 端口
 * @param {string} url - 要打开的 URL
 * @returns {Promise<{ ok: boolean, tab?: object, error?: string }>}
 */
function openTab(port, url) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/json/new?${encodeURIComponent(url)}`,
      method: 'PUT',
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tab = JSON.parse(data);
          resolve({ ok: true, tab });
        } catch (e) {
          resolve({ ok: false, error: '解析标签页响应失败' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/**
 * 查找已打开的标签页（匹配 URL 或标题）
 * @param {number} port - CDP 端口
 * @param {object} filter - { url?: string, title?: string, urlRegex?: string }
 * @returns {Promise<object|null>} - 匹配到的 target 或 null
 */
function findTab(port, filter) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/json',
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          for (const t of targets) {
            if (t.type !== 'page') continue;
            if (filter.url && t.url && t.url.includes(filter.url)) { resolve(t); return; }
            if (filter.title && t.title && t.title.includes(filter.title)) { resolve(t); return; }
            if (filter.urlRegex) {
              const re = new RegExp(filter.urlRegex);
              if (re.test(t.url || '')) { resolve(t); return; }
            }
          }
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * 激活（置顶）指定标签页
 * 通过 CDP /json/activate/{targetId} 实现
 * @param {number} port - CDP 端口
 * @param {string} targetId - 目标 tab 的 id
 */
function activateTab(port, targetId) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: `/json/activate/${targetId}`,
      headers: { Host: `127.0.0.1:${port}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ ok: data.includes('Target activated') || res.statusCode === 200 });
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false }); });
  });
}

/**
 * 完整的"智能连接"流程：
 *   1. 检查 CDP 端口是否可用
 *   2. 如果不可用 → 自动启动浏览器
 *   3. 端口可用后 → 查找是否已打开目标平台页面
 *   4. 如果没打开 → 自动打开新标签页
 *   5. 如果已打开 → 激活置顶
 *
 * @param {object} options - { cdpPort, platformUrl, targetFilter, profileDir }
 * @returns {Promise<{ ok: boolean, action: string, error?: string, tab?: object }>}
 */
async function smartConnect(options) {
  const { cdpPort, platformUrl, targetFilter, profileDir } = options;

  // Step 1: 检查 CDP 端口
  let portCheck = await checkCdpPort(cdpPort);

  // Step 2: 端口不可用 → 启动浏览器
  if (!portCheck.available) {
    const launchResult = await launchBrowser(cdpPort, platformUrl, profileDir);
    if (!launchResult.ok) {
      return { ok: false, action: 'launch_failed', error: launchResult.error };
    }
    // 启动时已带 URL，等待页面加载
    await sleep(2000);
    portCheck = await checkCdpPort(cdpPort);
    if (!portCheck.available) {
      return { ok: false, action: 'port_not_ready', error: '浏览器已启动但 CDP 端口未就绪' };
    }
    // 查找目标页面
    let tab = await findTab(cdpPort, targetFilter);
    if (tab) {
      return { ok: true, action: 'launched_and_opened', tab };
    }
    // 启动时 URL 可能没生效，再尝试主动打开
    if (platformUrl) {
      const openResult = await openTab(cdpPort, platformUrl);
      await sleep(2000);
      tab = await findTab(cdpPort, targetFilter);
      if (tab) {
        return { ok: true, action: 'launched_and_opened', tab };
      }
    }
    return { ok: false, action: 'launched_but_page_not_found', error: '浏览器已启动但未能打开目标页面' };
  }

  // Step 3: 端口可用 → 查找目标页面
  let tab = await findTab(cdpPort, targetFilter);

  // Step 4: 没找到 → 打开新标签页
  if (!tab && platformUrl) {
    const openResult = await openTab(cdpPort, platformUrl);
    await sleep(2000);
    tab = await findTab(cdpPort, targetFilter);
    if (tab) {
      return { ok: true, action: 'opened_new_tab', tab };
    }
    return { ok: false, action: 'open_tab_failed', error: '已打开新标签页但未找到目标页面' };
  }

  // Step 5: 找到了 → 激活置顶
  if (tab) {
    await activateTab(cdpPort, tab.id);
    return { ok: true, action: 'activated', tab };
  }

  return { ok: false, action: 'not_found', error: '未找到目标页面且无法自动打开' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  findBrowser,
  checkCdpPort,
  launchBrowser,
  openTab,
  findTab,
  activateTab,
  smartConnect,
};
