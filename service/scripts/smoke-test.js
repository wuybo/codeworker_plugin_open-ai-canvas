'use strict';
// service API 冒烟测试
const { spawn } = require('child_process');
const http = require('http');

const exe = process.argv[2] || './ecom-cs-service.exe';
const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', d => process.stdout.write('[svc] ' + d));
child.stderr.on('data', d => process.stdout.write('[svc-err] ' + d));

function get(p, tok) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 17389, path: p, headers: tok ? { 'X-Plugin-Token': tok } : {} }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  // 等待启动
  await new Promise(r => setTimeout(r, 2500));

  const health = await get('/api/health');
  console.log('health:', health);

  const tokResp = await get('/api/token');
  const token = JSON.parse(tokResp).token;
  console.log('token OK:', token.slice(0, 12) + '...');

  const unauth = await get('/api/platforms/status');
  console.log('no-token (expect 401 body):', unauth);

  const status = await get('/api/platforms/status', token);
  const st = JSON.parse(status);
  console.log('platforms (token):', JSON.stringify(st.statuses.qianniu), JSON.stringify(st.statuses.xhs));

  const pending = await get('/api/pending-ai-replies', token);
  console.log('pending:', pending);

  const ok = health.includes('"ok":true') && token && unauth.includes('unauthorized') && status.includes('debugPort');
  console.log('');
  console.log(ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED');

  child.kill();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); child.kill(); process.exit(1); });
