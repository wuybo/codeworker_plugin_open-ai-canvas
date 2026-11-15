# Code Worker 电商客服自动对话助手插件

> 基于 [ChatGPT-On-CS](https://github.com/cs-lazy-tools/ChatGPT-On-CS)（AGPL-3.0）底层 CDP 注入逻辑改写的 Code Worker 插件。
>
> 通过挂接千牛/抖店/拼多多等电商商家客户端的 WebView，读取买家消息，调用 Code Worker 自带 AI 生成回复，支持人工确认或自动回复。

## 功能

- **多平台接入**：千牛（淘宝/天猫）、抖店飞鸽、拼多多、京东咚咚、快手小店、小红书
- **消息收发**：通过 CDP 协议注入 JS 读取聊天 DOM、模拟输入发送回复
- **AI 起草**：调用 Code Worker 的 `ai.generate` 桥接，用 AI 根据上下文生成回复
- **人工/自动两种模式**：人工模式下需用户确认后发送；自动模式下匹配知识库自动回复
- **知识库**：自定义商品信息、常见问答，AI 回复时作为参考上下文
- **会话管理**：统一收件箱查看所有平台的消息

## 架构

```
Code Worker 主进程
  ├─ 加载 codeworker-plugin.json
  ├─ 显示 iframe UI（ui/index.html）
  │    ├─ postMessage → 宿主桥接（ai.generate / plugin.storage / notification）
  │    └─ fetch → localhost API（127.0.0.1:17389）
  └─ 启动 service/ecom-cs-service.exe
           ├─ HTTP 服务（localhost，token 认证）
           ├─ Browser Launcher（自动启动 Chrome/Edge 调试实例，专属端口+独立 profile）
           ├─ CDP Manager（WebSocket + Runtime.evaluate 注入 JS）
           └─ Platform Adapters（per-platform 页面URL / DOM 选择器 / 收发脚本）
```

## 工作原理

### 不是 API，是 CDP 注入 + 网页版工作台

淘宝/拼多多/抖音等电商平台**不向个人开放客服消息 API**。本插件采用 ChatGPT-On-CS 相同的底层思路：

1. 点击"连接"时，插件**自动启动一个专属 Chrome/Edge 实例**（带 `--remote-debugging-port`，独立 profile 目录）
2. 自动打开该平台**网页版客服工作台**（千牛网页版、飞鸽、拼多多商家后台、京麦、快手小店、小红书千帆）
3. 如果页面已打开 → 直接**激活置顶**并 attach
4. 通过 CDP 的 `Runtime.evaluate` 注入 JS 脚本：读取聊天 DOM 拿买家消息、模拟输入/点击发送回复

### 平台端口分配

每个平台一个独立调试端口和浏览器 profile（登录态互不干扰，可多平台同时挂接）：

| 平台 | 调试端口 | 客服页面 |
|---|---|---|
| 千牛 | 基础端口+0 (9222) | work.taobao.com |
| 抖店飞鸽 | +1 (9223) | im.jinritemai.com |
| 拼多多 | +2 (9224) | mms.pinduoduo.com/chat |
| 京东 | +3 (9225) | jmw.jd.cn |
| 快手小店 | +4 (9226) | im.kwaixiaodian.com |
| 小红书 | +5 (9227) | qian.xiaohongshu.com |

### AI 回复（复用 Code Worker 自带模型）

两种模式都通过宿主桥接调用 **Code Worker 自身的 AI**，不需要单独配置任何模型 API Key：

- **人工模式**：点"✨ AI 起草" → `ai.generate` 生成回复 → 你确认后手动发送
- **自动模式**：service 检测到买家消息 → 标记待回复 → UI 自动调 `ai.generate` → 延迟数秒自动发送（每次生成宿主会弹确认框）

### 各平台适配

每个平台有独立的适配器（`service/platforms.js`），包含：
- 目标页面的 URL 匹配规则 + 网页版客服入口 URL
- 读取消息的 DOM 选择器
- 发送消息的输入框/按钮选择器

> **注意**：各平台网页的 DOM 结构随版本更新会变化，选择器需要持续维护。
> 首次使用需在弹出的浏览器里登录商家账号（独立 profile，登录态会保留）。

## 回归测试

改完选择器/核心代码后可跑内置测试脚本验证链路：

```bash
cd service
node scripts/smoke-test.js ./ecom-cs-service.exe       # HTTP API 冒烟
node scripts/adapter-e2e-test.js ./ecom-cs-service.exe # 适配器全链路（百度模拟）
```

## 目录结构

```
codeworker_plugin_open-ai-canvas/
├─ codeworker-plugin.json    # 插件清单
├─ LICENSE                   # AGPL-3.0 协议全文
├─ README.md                 # 本文件
├─ ui/
│  ├─ index.html             # 插件 UI 入口
│  ├─ app.js                 # UI 逻辑（桥接 + 本地 API 调用）
│  └─ style.css              # UI 样式
├─ service/
│  ├─ index.js               # 后台服务入口（HTTP + 调度）
│  ├─ cdp.js                 # CDP 管理器（WebSocket + Runtime.evaluate）
│  ├─ browser-launcher.js    # 浏览器启动器（自动启动调试实例/打开/激活页面）
│  ├─ platforms.js           # 平台适配器（per-platform URL/选择器/脚本）
│  ├─ package.json           # 服务包定义
│  ├─ sea-config.json        # Node SEA 打包配置
│  └─ scripts/
│     ├─ bundle.js           # 多文件→单文件 bundler
│     ├─ build-sea.js        # SEA 打包脚本（生成 .exe）
│     ├─ smoke-test.js       # HTTP API 冒烟测试
│     └─ adapter-e2e-test.js # 适配器全链路测试
└─ scripts/
   └─ build.ps1              # 一键打包脚本（构建 + 打 .cwplugin）
```

## 开发与构建

### 环境要求

- **Node.js >= 22**（用于 SEA 打包）
- **PowerShell 5+**（运行打包脚本）
- **Windows 10/11**（目标平台）

### 构建 service.exe

```bash
cd service
npm install
node scripts/build-sea.js
```

产物：`service/ecom-cs-service.exe`

### 打包 .cwplugin

```powershell
.\scripts\build.ps1
```

产物：`dist/ecom-cs-bot-<version>.cwplugin`

### 本地安装测试

1. 打开 Code Worker → 设置 → 插件
2. 选择"导入本地插件包"
3. 选择 `.cwplugin` 文件
4. 授予权限（`ai.generate`、`plugin.storage`、`app.notification` 等）
5. 检查服务日志：`<CodeWorkerHome>/plugins/plugin-data/ecom-cs-bot/service.stdout.log`

### 使用步骤

1. 安装插件后，打开侧栏"客服助手"
2. 在"平台管理"页点击对应平台的"连接"按钮
   - 插件会**自动启动专属调试浏览器并打开该平台网页版客服工作台**
   - 首次使用需在弹出的浏览器窗口中登录商家账号（独立 profile，登录态保留）
   - 页面若已打开，会直接激活置顶
3. 在"收件箱"查看收到的买家消息
4. 点击"✨ AI 起草"让 Code Worker AI 生成回复（复用宿主模型，无需配 API Key），确认后点"发送"
5. 可选：开启"自动回复"——收到新消息后自动调用 AI 生成并发送（每次生成宿主会弹确认框）

## 许可证

**AGPL-3.0**（GNU Affero General Public License v3.0）

- 本插件基于 [ChatGPT-On-CS](https://github.com/cs-lazy-tools/ChatGPT-On-CS)（AGPL-3.0）的底层逻辑改写
- 根据 AGPL-3.0 要求，**任何修改和分发必须以 AGPL-3.0 开源**
- AGPL 额外要求：**通过网络提供服务也构成分发**，必须提供源码
- 源码仓库：https://github.com/wuybo/codeworker_plugin_open-ai-canvas

### 可以收费吗？

**可以。** AGPL 不禁止商业使用和收费。但买家获得代码后也有权再分发。可行的收费模式：
- 一键部署/托管服务
- 定制接入（帮商家对接特定平台）
- 技术支持/高级功能/工单服务
- 免费开源 + 增值服务

> 注意：Code Worker 插件市场当前付费链路尚未开放，短期只能走自有渠道分发。

## ⚠️ 合规风险提示

本插件通过 CDP 协议自动挂接电商网页版商家工作台读取/发送消息，属于第三方自动化工具。各电商平台（淘宝/拼多多/抖音等）用户协议**可能禁止此类行为**，存在**封店/封号风险**。

建议：
- 优先使用"人工确认"模式（AI 起草后人工审核发送）
- 了解各平台规则后再决定是否使用自动回复
- 合规替代方案：走各平台官方开放平台（淘宝服务市场、抖店开放平台、拼多多开放平台）申请企业资质使用官方客服 API

## 致谢

- [ChatGPT-On-CS](https://github.com/cs-lazy-tools/ChatGPT-On-CS) — 原始项目，CDP 注入思路和平台适配架构的来源
- [Code Worker](https://codeworker.com) — 插件宿主平台
