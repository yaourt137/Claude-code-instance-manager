# Claude Code 多实例管理器

基于浏览器的 Claude Code 多实例管理面板，通过 PTY 与 CLI 进程全双工通信，支持同时运行和管理多个 AI 编程会话。

## 功能特性

- **多实例并发**：同时启动多个 Claude Code / Codex / Gemini CLI 实例，独立窗口展示
- **实时终端**：xterm.js 渲染 PTY 输出，支持完整的 ANSI 转义序列
- **任务队列**：每个实例配有任务队列，支持排队发送、批量执行
- **Worktree 支持**：自动为每个实例创建独立 Git worktree，隔离代码变更，一键 merge / push
- **MCP Orchestrator**：内置 MCP 服务器，允许一个 Claude 实例通过工具调用派发任务给其他实例
- **AI 解释**：对话内容一键发送给 OpenAI / Anthropic 进行分析
- **中英文界面**：点击右上角 `EN / 中` 切换语言，设置持久化
- **PWA 支持**：可安装到桌面，离线访问 Service Worker 缓存
- **背景图片**：支持上传本地图片或 URL，存储于 IndexedDB（无大小限制）
- **底纹主题**：圆点、网格、斜线、交叉、噪点多种页面底纹
- **密码保护**：首次启动自动生成访问密码，支持修改

## 安装与启动

**环境要求**：Node.js 18+，已全局安装 `claude`（或 `codex` / `gemini`）

```bash
# 安装依赖（node-pty 需要编译原生模块）
npm run install-rebuild

# 启动服务
npm start
```

浏览器访问 `http://localhost:3000`，首次启动会在终端打印自动生成的访问密码。

自定义端口：

```bash
PORT=8080 npm start
```

## 项目结构

```
├── server.js          # Express + WebSocket 后端，PTY 管理
├── index.html         # 单文件前端（HTML / CSS / JS）
├── mcp-server.mjs     # MCP 工具服务器（orchestrator 模式）
├── sw.js              # Service Worker（PWA 离线缓存）
├── manifest.json      # PWA manifest
├── ai-settings.json   # AI 服务商配置（运行时生成）
└── auth-settings.json # 访问密码哈希（运行时生成）
```

## WebSocket 消息协议

前端通过 WebSocket 与后端通信，主要动作：

| action | 说明 |
|---|---|
| `subscribe` | 订阅某实例的 PTY 输出 |
| `pty_input` | 向 PTY 发送键盘输入 |
| `pty_resize` | 通知 PTY 终端尺寸变化 |

后端推送事件：`pty_output`、`instance_update`、`instances_list` 等。

## 注意事项

- `node-pty` 包含原生模块，升级 Node.js 后需重新执行 `npm rebuild node-pty`
- 上传的背景图片存储在浏览器 IndexedDB 中，清除浏览器数据会丢失
- Worktree 功能需要项目目录是 Git 仓库
