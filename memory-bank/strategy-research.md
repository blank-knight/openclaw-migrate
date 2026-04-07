# 策略研究

## 1. 原项目架构分析

### 模块职责

| 模块 | 行数 | 职责 |
|------|------|------|
| `bin/ccs.js` | 555 | CLI 入口，命令路由 |
| `src/http-proxy.js` | 175 | HTTP 反向代理，替换 OAuth Token |
| `src/token-store.js` | 498 | Token 持久化/刷新/同步 |
| `src/launcher.js` | 160 | 启动 Claude Code + 注入代理环境变量 |
| `src/daemon.js` | 87 | 守护进程：代理服务 + 控制服务 |
| `src/control-server.js` | 171 | 控制 API（import/switch/status/refresh） |
| `src/keepalive.js` | 86 | Token 保活（30 分钟刷新） |
| `src/utils.js` | 111 | 常量/工具函数 |

### 数据流

```
用户输入 → Claude Code CLI
  → 环境变量 ANTHROPIC_BASE_URL=127.0.0.1:9876
  → CCS 本地代理拦截请求
  → 替换 Authorization header 为当前激活账号的 OAuth Token
  → 转发到 api.anthropic.com
```

### Token 管理

```
keepalive (每30min) → 检查所有账号 → 过期前1h刷新 → 写回 config.json
                      ↕ 双向同步
              Claude Code credentials.json
```

## 2. OpenClaw 实例分析

### 需要迁移的文件清单

| 路径 | 类型 | 说明 | 必须 |
|------|------|------|------|
| `~/.openclaw/openclaw.json` | 配置 | API Key、模型、频道配置 | ✅ 脱敏后 |
| `~/clawd/SOUL.md` | 人格 | AI 助手的人格定义 | ✅ |
| `~/clawd/USER.md` | 用户 | 用户信息 | ✅ |
| `~/clawd/IDENTITY.md` | 身份 | 名称/头像 | ✅ |
| `~/clawd/AGENTS.md` | 规则 | 工作区规则 | ✅ |
| `~/clawd/TOOLS.md` | 工具 | 本地配置笔记 | ✅ |
| `~/clawd/MEMORY.md` | 长期记忆 | 精选记忆 | ✅ |
| `~/clawd/HEARTBEAT.md` | 心跳 | 定时任务 | ❌ 可选 |
| `~/clawd/memory/*.md` | 日记 | 每日记忆 | ✅ |
| `~/clawd/skills/` | 技能 | 自定义技能 | ✅ |
| `~/clawd/.git/` | Git | 版本历史 | ❌ 远程 clone |

### 不迁移的文件

| 路径 | 原因 |
|------|------|
| `.env` / API Keys | 安全：在远程手动配置 |
| `node_modules/` | 远程重新安装 |
| `*.db` / `*.log` | 本地运行数据 |
| 私钥/钱包文件 | 安全 |

### 脱敏策略

`openclaw.json` 中的敏感字段：
- `anthropic.apiKey` → 传输时替换为 `__MIGRATE_PLACEHOLDER__`
- `telegram.botToken` → 同上
- 其他 API Key → 同上

用户在远程 `ccs migrate config` 手动填入真实值。

## 3. 迁移策略

### 方案选择

| 方案 | 优点 | 缺点 |
|------|------|------|
| **rsync over SSH** | 增量传输、高效 | 需要 rsync |
| **scp** | 简单 | 全量传输 |
| **tar + ssh pipe** | 单命令、原子性 | 无增量 |
| **git push + pull** | 版本管理 | 需要远程 repo |

**选定方案**：`rsync over SSH`
- 支持 `--dry-run` 预览
- 增量传输只传变化
- 排除规则灵活
- Linux/macOS 自带，Windows (WSL2) 也有

### SSH 连接

- 优先使用 `~/.ssh/config` 中的配置
- 支持密钥认证（推荐）和密码认证（fallback）
- 使用 `ssh2` 库纯 Node.js 实现（不依赖系统 ssh）

**选定方案**：直接调用系统 `rsync` + `ssh` 命令
- 零依赖（不引入 ssh2 库）
- 简单可靠
- 与原项目风格一致（零第三方依赖）

## 4. 风险评估

| 风险 | 等级 | 应对 |
|------|------|------|
| 敏感信息泄露 | 高 | 脱敏传输，远程手动配置 |
| 远程 Node.js 版本不兼容 | 中 | 迁移前检查版本 |
| 网络中断导致不完整迁移 | 中 | rsync 天然幂等，重跑即可 |
| 远程 OpenClaw 安装失败 | 中 | 提供诊断命令 `ccs migrate doctor` |
| 记忆文件冲突（双向修改） | 低 | sync 只单向推送，不拉取 |
