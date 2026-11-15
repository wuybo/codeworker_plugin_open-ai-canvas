'use strict';
// WS 握手诊断脚本（临时测试用）
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '9337', 10);

http.get({ hostname: '127.0.0.1', port: PORT, path: '/json', headers: { Host: 'localhost' } }, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const t = JSON.parse(d).find(x => x.type === 'page');
    if (!t) { console.log('no page target'); process.exit(1); }
    console.log('full ws url:', t.webSocketDebuggerUrl);

    // 解析 ws url
    const u = new URL(t.webSocketDebuggerUrl.replace(/^ws:/, 'http:'));
    const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
    const port = parseInt(u.port || String(PORT), 10);
    const p = u.pathname;
    console.log('parsed host:', host, 'port:', port, 'path:', p.slice(0, 50));

    // 原始 WS 握手
    const sock = net.connect(port, host);
    const key = crypto.randomBytes(16).toString('base64');
    sock.on('connect', () => {
      sock.write(
        `GET ${p} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`
      );
    });
    let got = '';
    sock.on('data', b => {
      got += b.toString('utf8', 0, 300);
      if (got.includes('\r\n\r\n')) {
        console.log('HANDSHAKE RESPONSE:\n' + got.split('\r\n\r\n')[0]);
        sock.destroy();
        process.exit(0);
      }
    });
    sock.on('error', e => { console.log('socket error:', e.message); process.exit(1); });
    setTimeout(() => { console.log('timeout, got=', got.slice(0, 200)); process.exit(1); }, 5000);
  });
}).on('error', e => { console.log('http error:', e.message); process.exit(1); });
