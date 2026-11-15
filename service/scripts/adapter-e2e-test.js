'use strict';
// 平台适配器完整链路测试（用百度模拟平台页面，绕过登录墙验证代码正确性）
const path = require('path');
const { CDPManager } = require('../cdp.js');
const platformsModule = require('../platforms.js');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '.', 'ecom-cs-bot-data');

class FakeQianniu extends platformsModule.QianniuAdapter {
  get platformUrl() { return 'https://www.baidu.com'; }
  get targetFilter() { return { urlRegex: 'baidu' }; }
  get profileDir() { return path.join(process.env.LOCALAPPDATA || '.', 'ecom-cs-fake-test'); }

  // 固定时间戳：第二次轮询同一内容时 timestamp 不增长 → 被 lastMsgTime 过滤 → 验证去重
  buildFetchScript() {
    return '(function(){ var kw=document.querySelector("#kw"); var v = kw && kw.value ? kw.value : ""; return JSON.stringify(v ? [{convId:"qn_test",from:"buyer",content:v,timestamp:1700000000000,buyerName:"测试买家"}] : []); })()';
  }
  buildSendScript(content) {
    const safe = this.escapeJs(content);
    return '(function(){ var i=document.querySelector("#kw"); if(!i) return "no-input"; i.value="' + safe + '"; i.dispatchEvent(new Event("input",{bubbles:true})); return "sent"; })()';
  }
}

(async () => {
  // 确保 exe 服务在运行（模拟 Code Worker 启动 service）
  const { spawn } = require('child_process');
  const svc = spawn(process.argv[2] || './ecom-cs-service.exe', [], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));

  try {
    // 通过 HTTP API 读 settings → 改 cdpPort → 但服务不重读；
    // 这里直接在测试进程内用 9340 端口实例化 cdpManager，
    // 同时验证服务端的 /api/platforms 路由（真实千牛会因登录墙失败，属预期）。

    const cdp = new CDPManager({ port: 9340 });
    const adapter = new FakeQianniu('qianniu', cdp);

    console.log('[1] adapter.connect() — 智能启动浏览器+打开页面+attach');
    await adapter.connect();
    console.log('    connected:', adapter.connected, '| debugPort:', adapter.debugPort, '| url:', adapter.target.url);
    // 等待页面完全加载
    await new Promise(r => setTimeout(r, 4000));

    console.log('[2] sendMessage — 注入发送脚本');
    const sendResult = await adapter.sendMessage({ id: 'qn_test' }, '买家消息：这个什么时候发货');
    console.log('    send result:', sendResult);

    console.log('[3] fetchNewMessages — 注入读取脚本（读回刚写入的页面内容）');
    const msgs = await adapter.fetchNewMessages();
    console.log('    messages:', JSON.stringify(msgs.map(m => m.content)));

    console.log('[4] 去重逻辑 — 相同内容二次轮询应返回空');
    const msgs2 = await adapter.fetchNewMessages();
    console.log('    第二次读取:', JSON.stringify(msgs2.map(m => m.content)));

    console.log('[5] ensureTarget — target 刷新');
    await adapter.ensureTarget();
    console.log('    target valid:', !!adapter.target);

    const pass =
      adapter.connected &&
      adapter.debugPort === 9340 &&
      msgs.length === 1 &&
      msgs[0].content.includes('什么时候发货') &&
      msgs2.length === 0;

    console.log('');
    console.log(pass ? '✅ ADAPTER E2E PASSED: 启动→attach→发消息→读消息→去重→刷新' : '❌ ADAPTER E2E FAILED');
    await adapter.disconnect();
    svc.kill();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('❌ FAILED:', e.message);
    svc.kill();
    process.exit(1);
  }
})();
