# OpenClaw Migrate

> One-command OpenClaw instance migration + Claude Code account switch

[中文](#中文说明) | [English](#english)

---

## 中文说明

CCS 是一个 Windows 命令行工具，让你在 **不重启 Claude Code、不丢失当前对话上下文** 的前提下，无缝切换多个 Claude 账号。

### 为什么需要它？

当你的 Claude 账号达到使用限制时，通常需要退出当前会话、重新登录另一个账号、再重新开始对话。CCS 通过本地反向代理拦截请求并替换认证令牌，让你在同一个会话中直接切换到另一个账号继续工作。

### 功能特性

- **无缝切换**：不中断当前 Claude Code 会话，下一次请求自动使用新账号
- **多账号管理**：导入、查看、切换多个 Claude 账号
- **Token 保活**：独立后台 keepalive 进程，每 30 分钟自动刷新所有即将过期的 token
- **智能 401 恢复**：上游返回认证失败时，自动通过三步策略恢复（检查 config → 同步 credentials → OAuth 刷新），对 Claude Code 完全透明
- **双向 token 同步**：CCS 与 Claude Code 的凭据文件自动互相同步，避免 token 失效
- **重复导入检测**：防止同一 token 被导入为不同账号名
- **零依赖**：仅使用 Node.js 内置模块，无需安装任何第三方包
- **与原版共存**：`ccs` 和原版 `claude` 命令互不干扰

### 系统要求

- Windows 10/11
- Node.js >= 18.0.0
- Claude Code CLI 已安装（`claude` 命令可用）

### 安装

```powershell
git clone https://github.com/guoy0701/claude-code-account-switch.git
cd claude-code-account-switch
npm install -g .
```

安装后 `ccs` 命令即可全局使用。

### 使用流程

#### 1. 导入账号

先用原版 Claude 登录第一个账号，然后导入：

```powershell
# 在 Claude Code 中使用 /login 登录账号 A
# 退出 Claude Code 后执行：
ccs import account_a
```

再登录第二个账号并导入：

```powershell
# 在 Claude Code 中先 /logout，再 /login 登录账号 B
# 退出 Claude Code 后执行：
ccs import account_b
```

导入时会自动启动 keepalive 保活服务，确保 token 不会过期。

#### 2. 启动代理模式

```powershell
ccs claude --dangerously-skip-permissions
# 或简写：
ccs --dangerously-skip-permissions
```

#### 3. 切换账号

当账号 A 达到限制时，在另一个终端窗口执行：

```powershell
ccs switch account_b
```

回到 Claude Code 窗口继续输入即可，下一次请求会自动使用账号 B。

### 命令参考

| 命令 | 说明 |
|------|------|
| `ccs [claude] [参数...]` | 启动代理模式的 Claude Code |
| `ccs import <名称> [凭据路径]` | 导入账号（默认读取 `~/.claude/.credentials.json`） |
| `ccs switch <名称>` | 切换当前账号（下一次请求生效） |
| `ccs status` | 查看当前状态 |
| `ccs accounts` | 列出所有已导入账号 |
| `ccs keepalive` | 启动 token 保活服务 |
| `ccs keepalive stop` | 停止保活服务 |
| `ccs keepalive status` | 查看保活服务状态 |
| `ccs doctor` | 诊断检查 |
| `ccs stop` | 停止后台 daemon |

### 工作原理

```
用户输入 → Claude Code CLI → CCS 本地代理 (127.0.0.1:9876) → Anthropic API
                                     ↑
                              替换 OAuth token
                              为当前激活账号的 token
```

CCS 在本地启动一个反向代理服务器，拦截 Claude Code 发出的所有 API 请求，将认证头替换为当前激活账号的 OAuth token 后转发到 Anthropic API。切换账号时只需更改激活账号，下一次请求自动使用新 token。

#### Token 生命周期管理

CCS 通过多层机制确保 token 始终可用：

1. **Keepalive 保活进程**：独立后台进程，每 30 分钟扫描所有账号，提前刷新即将过期（< 1 小时）的 token
2. **401 智能恢复**：当上游返回 401 时，按优先级尝试三步恢复：
   - 检查 config 文件是否已被 keepalive 更新
   - 从 Claude Code 的 credentials 文件同步
   - 最后才执行 OAuth refresh
3. **双向同步**：CCS 刷新后会写回 Claude Code 凭据文件，反之亦然

### 注意事项

- 登录和登出需要在原版 Claude Code 中使用 `/login` 和 `/logout` 命令（不是 `claude login`）
- `ccs` 不会替换或修改原版 `claude` 命令
- 同一个账号不要同时在 `ccs` 和原版 `claude` 中使用，否则 refresh token 会互相失效
- 此工具面向个人本地使用，请自行评估平台政策风险

---

## English

CCS is a Windows CLI tool that lets you **seamlessly switch between multiple Claude accounts** without restarting Claude Code or losing your conversation context.

### Why?

When your Claude account hits its usage limit, you normally have to quit, log into another account, and start a new conversation. CCS runs a local reverse proxy that swaps the OAuth token on the fly, so you can switch accounts and keep working in the same session.

### Features

- **Seamless switching**: no session restart, the next request uses the new account automatically
- **Multi-account management**: import, list, and switch between accounts
- **Token keepalive**: independent background process refreshes all tokens every 30 minutes before they expire
- **Smart 401 recovery**: automatically recovers from auth failures via a three-step strategy (check config → sync credentials → OAuth refresh), fully transparent to Claude Code
- **Bidirectional token sync**: CCS and Claude Code's credential files stay in sync automatically
- **Duplicate import detection**: prevents the same token from being imported under different names
- **Zero dependencies**: uses only Node.js built-in modules
- **Non-invasive**: `ccs` and the original `claude` command coexist without conflict

### Requirements

- Windows 10/11
- Node.js >= 18.0.0
- Claude Code CLI installed (`claude` command available)

### Installation

```powershell
git clone https://github.com/guoy0701/claude-code-account-switch.git
cd claude-code-account-switch
npm install -g .
```

The `ccs` command will be available globally after installation.

### Quick Start

#### 1. Import Accounts

Log in with each account in the original Claude Code and import:

```powershell
# Log in with account A using /login inside Claude Code
# After exiting Claude Code:
ccs import account_a

# Log out with /logout, log in with account B using /login
# After exiting Claude Code:
ccs import account_b
```

The keepalive service starts automatically after import to keep tokens fresh.

#### 2. Launch Proxy Mode

```powershell
ccs claude --dangerously-skip-permissions
# or simply:
ccs --dangerously-skip-permissions
```

#### 3. Switch Accounts

When account A hits its limit, open another terminal and run:

```powershell
ccs switch account_b
```

Go back to the Claude Code window and keep typing. The next request will use account B.

### Command Reference

| Command | Description |
|---------|-------------|
| `ccs [claude] [args...]` | Launch Claude Code in proxy mode |
| `ccs import <name> [cred-path]` | Import account (defaults to `~/.claude/.credentials.json`) |
| `ccs switch <name>` | Switch active account (takes effect on next request) |
| `ccs status` | Show current status |
| `ccs accounts` | List all imported accounts |
| `ccs keepalive` | Start token keepalive service |
| `ccs keepalive stop` | Stop keepalive service |
| `ccs keepalive status` | Check keepalive service status |
| `ccs doctor` | Run diagnostics |
| `ccs stop` | Stop background daemon |

### How It Works

```
User input → Claude Code CLI → CCS local proxy (127.0.0.1:9876) → Anthropic API
                                       ↑
                                Replaces OAuth token
                                with the active account's token
```

CCS starts a local reverse proxy that intercepts all API requests from Claude Code, replaces the authentication header with the active account's OAuth token, and forwards the request to Anthropic's API. Switching accounts simply changes which token is injected on the next request.

#### Token Lifecycle Management

CCS uses multiple layers to keep tokens always valid:

1. **Keepalive process**: an independent background process scans all accounts every 30 minutes and proactively refreshes tokens expiring within 1 hour
2. **Smart 401 recovery**: when the upstream returns 401, recovery is attempted in priority order:
   - Check if the config file was already updated by keepalive
   - Sync from Claude Code's credentials file
   - OAuth refresh as a last resort
3. **Bidirectional sync**: after CCS refreshes a token, it writes back to Claude Code's credential file, and vice versa

### Important Notes

- Use `/login` and `/logout` commands inside Claude Code to manage authentication (not `claude login`)
- `ccs` does not replace or modify the original `claude` command
- Do not use the same account simultaneously in `ccs` and the original `claude` — their refresh tokens will invalidate each other
- This tool is intended for personal local use. Please evaluate platform policy risks on your own

---

## 🚀 OpenClaw 一键迁移 (新增功能)

将本地 OpenClaw AI 助手实例（记忆/人格/配置/技能）一键迁移到远程服务器。

### 快速开始

```bash
# 1. 诊断环境
ccs migrate doctor root@your-server-ip

# 2. 预览迁移（不实际传输）
ccs migrate root@your-server-ip --dry-run

# 3. 正式迁移
ccs migrate root@your-server-ip

# 4. SSH 到远程，填入真实 API Key
ssh root@your-server-ip
nano ~/clawd/openclaw.json
# 将 __MIGRATE_PLACEHOLDER__ 替换为真实值
openclaw gateway restart
```

### 日常同步

```bash
# 只同步最新的记忆文件（增量）
ccs migrate sync root@your-server-ip

# 查看远程状态
ccs migrate status root@your-server-ip
```

### 迁移包含的文件

| 类型 | 文件 |
|------|------|
| 人格 | SOUL.md, IDENTITY.md |
| 记忆 | MEMORY.md, memory/*.md |
| 配置 | AGENTS.md, TOOLS.md, HEARTBEAT.md |
| 技能 | skills/** |
| 系统配置 | openclaw.json（API Key 脱敏传输） |

### 排除的文件

`.env`, `.git`, `node_modules`, `__pycache__`, `*.db`, `*.log`, `venv/`, `memory-bank/`, `polymarket-*`, `new-api` 等

### 安全设计

- openclaw.json 中的 API Key / Secret / Token 自动替换为 `__MIGRATE_PLACEHOLDER__`
- 传输完成后需手动在远程填写真实值
- rsync 增量传输 + scp fallback
- 零第三方依赖，仅用 Node.js 内置模块

### 前提条件

- 本地：rsync、ssh 可用
- 远程：Node.js >= 18
- SSH 免密登录已配置（`ssh-copy-id user@host`）

## License

MIT
