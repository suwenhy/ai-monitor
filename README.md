# AI Monitor

AI Monitor 是一款基于 Electron 和 Vue 3 的本地桌面监控工具，用于集中查看 Codex 与 Claude Code 的运行状态、最近会话和用量信息。

应用仅在本机读取进程与会话元数据，不会上传对话内容，也不会修改 Codex 或 Claude 的配置。

## 功能

- 分区展示 Codex Desktop 与 Claude Desktop / Claude Code 状态
- 自动发现桌面客户端、CLI 和本地数据目录
- 检测相关进程及最近活动会话
- 展示会话状态、模型、工作目录、最新消息、更新时间和 Token 用量
- 过滤全部会话或仅查看活动会话
- 过滤 Codex 子代理线程和 Claude `subagents` 子会话
- 展示 Codex 上下文 Token 与账号额度百分比（本地数据可用时）
- 展示 Claude 五小时、七天额度以及历史模型统计（本地数据可用时）
- 支持浅色、深色主题和窄窗口布局
- 提供可置顶的活动浮窗，并在任务完成或等待确认时提醒
- 支持打开会话记录文件，以及在客户端支持时跳转或恢复会话

## 下载与安装

请从 [GitHub Releases](https://github.com/suwenhy/ai-monitor/releases/latest) 下载适合当前系统的安装包。

| 系统 | 处理器 | 推荐文件 |
| --- | --- | --- |
| macOS | Apple Silicon（M1/M2/M3/M4 等） | `AI Monitor-*-arm64.dmg` |
| macOS | Intel | `AI Monitor-*-x64.dmg` |
| Windows | x64 | `AI Monitor Setup *-x64.exe` |
| Windows | x64 免安装版 | `AI Monitor *-x64.exe` |
| Linux | x64 | `AI Monitor-*-x86_64.AppImage` |

当前发布包没有使用 Apple Developer ID 或 Windows 代码签名证书：

- macOS 首次启动若被系统拦截，请在“访达”中右键应用并选择“打开”。
- Windows 首次启动可能出现 SmartScreen 提示，请确认文件来源后选择继续运行。
- Linux AppImage 下载后需要先添加执行权限：`chmod +x "AI Monitor-*-x86_64.AppImage"`。

## 使用说明

启动后，应用每 3 秒刷新一次本地状态；界面中的相对时间每秒更新，不会额外扫描文件。

点击会话行时：

- Codex 会优先使用客户端会话链接打开对应任务，失败时再使用 CLI 恢复。
- Claude CLI 会话可通过 Claude Desktop 的 `resume` 入口导入并打开。
- Claude Desktop 当前没有公开的本地 Code 会话精确定位链接。为避免创建重复的 “General coding session”，对于原生 Desktop 会话，AI Monitor 只会激活 Claude Desktop，不会重复导入，也不会打开终端。

“置顶浮窗”会打开一个独立的小窗口，持续显示活动会话、最新消息和状态提醒。该窗口可以保持在其他窗口上方，适合在编码时观察任务是否完成或正在等待确认。

## 数据来源

| 服务 | 本地数据来源 |
| --- | --- |
| Codex | `$CODEX_HOME` 或 `~/.codex`、`sessions/**/*.jsonl`、本地进程列表 |
| Claude | `$CLAUDE_CONFIG_DIR` 或 `~/.claude`、`projects/**/*.jsonl`、`stats-cache.json`、Claude Desktop `plan-usage-history.json`、`claude agents --json`、本地进程列表 |

Codex Desktop 的部分运行状态只存在于客户端进程中，因此 AI Monitor 会结合持久化生命周期事件和文件最近活动时间判断会话状态。Claude Code 则会综合 CLI 代理、进程、记录事件及文件更新时间进行判断。

Claude 订阅额度是动态窗口，应用展示 Claude Desktop 本地记录的剩余百分比，不会将百分比换算成一个并不存在的固定 Token 数量。

## 平台支持

- macOS：支持 Codex Desktop、Claude Desktop 和对应 CLI 的本地监控。
- Windows：支持已安装的桌面客户端、CLI 和本地会话目录。
- Linux：目前主要用于监控 Codex CLI 与 Claude Code CLI，本地桌面客户端发现能力有限。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

仅预览网页界面和模拟数据：

```bash
npm run dev:web
```

不打开主窗口，直接输出真实的本地采集快照：

```bash
npm run snapshot
```

## 构建

```bash
npm run build
npm run dist:mac
npm run dist:win
npm run dist:linux
```

正式发布时建议在目标系统上完成构建和代码签名。当前项目没有原生 Node.js 依赖，也可以使用 Electron Builder 在 macOS 上生成未签名的 Windows、Linux 安装包。

## 隐私与安全

- Electron 渲染进程启用了上下文隔离和沙箱，不开放 Node.js 集成。
- 文件系统与进程访问仅发生在 Electron 主进程。
- 渲染进程只能通过受限的 preload 接口读取监控快照或请求打开本地位置。
- 应用不会修改 Codex 或 Claude 配置。
- 应用不会把会话内容或统计数据上传到远程服务。
