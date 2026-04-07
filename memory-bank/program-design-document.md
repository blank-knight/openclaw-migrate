# Claude Code Account Switch — 项目设计文档

## 1. 项目概述

**项目名称**：Claude Code Account Switch (CCS) + OpenClaw Migration

**项目目标**：在 [guoy0701/claude-code-account-switch](https://github.com/guoy0701/claude-code-account-switch) 开源项目基础上，新增 OpenClaw 实例迁移功能，实现一键将本地 AI 助手（记忆/人格/配置/技能）部署到远程服务器。

**项目背景**：
- 原项目 CCS 已实现 Claude Code 多账号无缝切换（本地反向代理 + Token 保活）
- 用户需要一个"AI 分身"部署到服务器上 7×24 帮忙干活
- 手动迁移 OpenClaw 实例（配置文件、记忆、人格、技能）步骤繁琐且容易遗漏
- 需要 `ccs migrate` 一键完成

## 2. 核心功能

### 2.1 原项目功能（保留）
- `ccs import` — 导入 Claude 账号凭据
- `ccs switch` — 无缝切换账号（不中断对话）
- `ccs status` — 查看状态
- `ccs accounts` — 列出所有账号
- `ccs keepalive` — Token 保活（30分钟自动刷新）
- `ccs doctor` — 诊断检查
- `ccs claude` — 启动代理模式的 Claude Code

### 2.2 新增功能：OpenClaw 迁移

#### `ccs migrate <user@host>`
一键迁移本地 OpenClaw 实例到远程服务器：

**打包阶段**（本地）：
1. 扫描 `~/.openclaw/` 目录（配置、技能、Node 配置）
2. 扫描 workspace 目录（SOUL.md、MEMORY.md、memory/、TOOLS.md、IDENTITY.md、HEARTBEAT.md）
3. 排除不必要的文件（node_modules、.git、venv、__pycache__、*.db、*.log）
4. 打包为 `~/.ccs/migrate/openclaw-backup.tar.gz`
5. 估算打包大小，超过 100MB 警告

**传输阶段**：
1. 通过 SCP 传输到远程 `~/.ccs/migrate/`
2. 显示传输进度

**部署阶段**（远程）：
1. 检查远程环境（Node.js、npm、SSH 连通性）
2. 安装 OpenClaw（`npm i -g openclaw`）
3. 解压备份文件
4. 恢复配置文件到 `~/.openclaw/`
5. 恢复 workspace 到指定目录
6. 启动 `openclaw gateway start`
7. 返回连接信息（Gateway URL、状态）

#### `ccs migrate sync <user@host>`
增量同步记忆文件（只传变化的）：
1. 比较本地和远程 `memory/*.md`、`MEMORY.md`、`SOUL.md` 的修改时间
2. 只同步有变化的文件
3. 适合日常更新，不需要完整迁移

#### `ccs migrate status <user@host>`
查看远程 OpenClaw 实例状态：
1. SSH 到远程执行 `openclaw status`
2. 显示 Gateway 状态、连接的 Node、最近活动

## 3. 用户故事

**作为用户，我想要**：
1. 在本地和主AI助手协作（写代码、管理项目）
2. 在服务器上部署一个"分身"，7×24 自动化执行任务
3. 一条命令完成迁移，不用手动 scp + ssh + 配置
4. 定期同步本地记忆到服务器，保持"分身"的知识更新

## 4. 约束条件

- **操作系统**：原项目仅支持 Windows，迁移功能需支持 Linux (WSL2) + macOS
- **SSH 依赖**：迁移功能依赖 SSH 密钥认证（不支持密码交互）
- **安全**：不传输 .env 文件（含 API Key/私钥），由用户手动在远程配置
- **网络**：假设本地可 SSH 到远程服务器
- **Node.js**：远程服务器需 Node.js >= 18

## 5. 排除项

- 不修改原项目的核心代理功能（http-proxy.js、token-store.js）
- 不实现实时双向同步（太复杂，用增量 sync 替代）
- 不支持 Docker 部署（直接 npm 全局安装）
