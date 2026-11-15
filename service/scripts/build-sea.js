/**
 * Node SEA (Single Executable Application) 打包脚本
 *
 * 将 service/index.js + cdp.js + platforms.js 打包成单个 ecom-cs-service.exe
 * 使用 Node.js 22 内置的 SEA 功能，无需安装额外依赖。
 *
 * 用法: node scripts/build-sea.js
 *
 * 许可证: AGPL-3.0
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_DIR = path.resolve(__dirname, '..');
const OUTPUT_EXE = path.join(SERVICE_DIR, 'ecom-cs-service.exe');

console.log('=== 电商客服服务 SEA 打包 ===\n');

// Step 1: 生成 SEA blob
console.log('[1/5] 生成 SEA blob...');
execSync('node --experimental-sea-config sea-config.json', {
  cwd: SERVICE_DIR,
  stdio: 'inherit',
});

const blobPath = path.join(SERVICE_DIR, 'sea-prep.blob');
if (!fs.existsSync(blobPath)) {
  console.error('ERROR: SEA blob 生成失败');
  process.exit(1);
}
console.log(`  blob: ${blobPath} (${fs.statSync(blobPath).size} bytes)\n`);

// Step 2: 复制 node.exe 作为基础
console.log('[2/5] 复制 node.exe...');
const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, OUTPUT_EXE);
console.log(`  base: ${OUTPUT_EXE}\n`);

// Step 3: 移除签名（如果已签名）
console.log('[3/5] 处理可执行文件签名...');
try {
  // Windows: 使用 sigcheck 或 postject 会自动处理
  // 如果有 sigthief 可用则移除签名
  execSync('sigthief -i "' + OUTPUT_EXE + '" -o "' + OUTPUT_EXE + '"', { stdio: 'pipe' });
  console.log('  签名已移除\n');
} catch (e) {
  console.log('  无需移除签名（或 sigthief 不可用）\n');
}

// Step 4: 注入 SEA blob
console.log('[4/5] 注入 SEA blob...');
const postjectBin = path.join(
  path.dirname(require.resolve('postject')),
  'bin',
  'cli.js'
);

let postjectCmd;
if (fs.existsSync(postjectBin)) {
  postjectCmd = `node "${postjectBin}" "${OUTPUT_EXE}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;
} else {
  // 尝试 npx
  postjectCmd = `npx postject "${OUTPUT_EXE}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;
}

try {
  execSync(postjectCmd, { stdio: 'inherit' });
  console.log('  blob 已注入\n');
} catch (e) {
  console.error('ERROR: postject 注入失败:', e.message);
  console.error('请安装 postject: npm install -g postject');
  process.exit(1);
}

// Step 5: 验证
console.log('[5/5] 验证产物...');
const size = fs.statSync(OUTPUT_EXE).size;
console.log(`  产物: ${OUTPUT_EXE}`);
console.log(`  大小: ${(size / 1024 / 1024).toFixed(1)} MB\n`);

// 简单验证：执行 --version
try {
  const output = execSync(`"${OUTPUT_EXE}" --version`, { timeout: 5000 }).toString();
  console.log(`  版本: ${output.trim()}\n`);
} catch (e) {
  console.log('  (跳过运行验证)\n');
}

console.log('=== 打包完成 ===');
console.log(`\n产物: ${OUTPUT_EXE}`);
console.log('将该文件放入插件包的 service/ 目录即可。');
