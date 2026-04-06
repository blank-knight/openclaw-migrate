# CCS - Claude Code Account Switcher

[中文](#中文说明) | [English](#english)

---

## 中文说明

CCS 是一个 Windows 命令行工具，让你在 **不重启 Claude Code、不丢失当前对话上下文** 的前提下，无缝切换多个 Claude 账号。

### 为什么需要它？

当你的 Claude 账号达到使用限制时，通常需要退出当前会话、重新登录另一个账号、再重新开始对话。CCS 通过本地反向代理拦截请求并替换认证令牌，让你在同一个会话中直接切换到另一个账号继续工作。

### 功能特性

- 无缝切换：不中断当前 Claude Code 会话，下一次请求自动使用新账号
- 多账号管理：导入、查看、切换多个 Claude 账号
- 自动刷新：后台自动刷新即将过期的 OAuth token
- 零依赖：仅使用 Node.js 内置模块，无需安装任何第三方包
- 与原版共存：`ccs` 和原版 `claude` 命令互不干扰

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

- Seamless switching: no session restart, the next request uses the new account automatically
- Multi-account management: import, list, and switch between accounts
- Auto-refresh: background daemon keeps OAuth tokens fresh
- Zero dependencies: uses only Node.js built-in modules
- Non-invasive: `ccs` and the original `claude` command coexist without conflict

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

### Important Notes

- Use `/login` and `/logout` commands inside Claude Code to manage authentication (not `claude login`)
- `ccs` does not replace or modify the original `claude` command
- Do not use the same account simultaneously in `ccs` and the original `claude` — their refresh tokens will invalidate each other
- This tool is intended for personal local use. Please evaluate platform policy risks on your own

## License

MIT
