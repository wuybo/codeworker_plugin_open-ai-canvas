'use strict';
// 全链路验证脚本：启动浏览器 → smartConnect → WS evaluate → DOM 读写
const bl = require('../browser-launcher.js');
const { CDPManager } = require('../cdp.js');

const PORT = parseInt(process.argv[2] || '9338', 10);

(async () => {
  const cdp = new CDPManager();
  await new Promise(r => setTimeout(r, 4000)); // 等页面加载

  const tab = await bl.findTab(PORT, { urlRegex: 'baidu' });
  if (!tab) { console.log('tab not found'); process.exit(1); }

  const title = await cdp.evaluateOn(tab, 'document.title');
  console.log('title =', JSON.stringify(title));

  const inject = await cdp.evaluateOn(tab, [
    '(function(){',
    '  var i = document.querySelector("#kw");',
    '  if (!i) return "no-input";',
    '  i.value = "注入成功";',
    '  i.dispatchEvent(new Event("input", { bubbles: true }));',
    '  return "ok:" + i.value;',
    '})()',
  ].join(''));
  console.log('inject =', inject);

  const pass = title && title.indexOf('百度') >= 0 && String(inject).indexOf('ok:') === 0;
  console.log(pass ? 'ALL PASSED' : 'PARTIAL');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
