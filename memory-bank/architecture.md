# 架构设计

## 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                      bin/ccs.js                         │
│                    (CLI 入口路由)                         │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ import   │ switch   │ status   │ claude   │  migrate    │
│          │          │          │          │   (新增)     │
├──────────┴──────────┴──────────┴──────────┼─────────────┤
│              原有模块 (不动)                 │ src/migrate │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐  │  .js (新增)  │
│  │http-proxy│ │token-store│ │launcher  │  │             │
│  └──────────┘ └──────────┘ └──────────┘  │             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐  │             │
│  │ daemon   │ │control-  │ │keepalive │  │             │
│  │          │ │server    │ │          │  │             │
│  └──────────┘ └──────────┘ └──────────┘  │             │
├───────────────────────────────────────────┴─────────────┤
│              Node.js 内置模块                            │
│  child_process | fs | path | os | http | https           │
└─────────────────────────────────────────────────────────┘
```

## 新增模块：src/migrate.js

### 职责
- OpenClaw 实例迁移（本地 → 远程服务器）
- 文件脱敏（替换敏感字段为占位符）
- rsync 文件传输（排除规则）
- 远程环境检查 & 安装
- 增量同步

### 导出函数

```javascript
module.exports = {
  migrateFull,      // 完整迁移
  migrateSync,      // 增量同步
  migrateStatus,    // 远程状态查询
  migrateDoctor,    // 远程环境诊断
};
```

### 数据流

```
本地 OpenClaw 工作区 (~/clawd/)
  │
  ├─ 1. 扫描文件清单
  │     SOUL.md, USER.md, IDENTITY.md, AGENTS.md
  │     openclaw.json (脱敏)
  │     memory/*.md
  │     skills/**/*
  │     TOOLS.md, HEARTBEAT.md, MEMORY.md
  │
  ├─ 2. 脱敏处理
  │     openclaw.json 中的 apiKey/botToken/secret → __MIGRATE_PLACEHOLDER__
  │
  ├─ 3. rsync 传输
  │     rsync -avz --exclude='.env' --exclude='node_modules' ...
  │     → user@host:~/clawd/
  │
  ├─ 4. 远程部署
  │     ssh user@host "npm install -g openclaw && openclaw gateway start"
  │
  └─ 5. 生成报告
        migrate-report.json (列出需要手动填入的字段)
```

## 排除规则

```
.env              # API Key / 私钥
.git/             # 版本历史
node_modules/     # 远程重装
__pycache__/      # Python 缓存
.venv/            # Python 虚拟环境
venv/
*.db              # 本地数据库
*.log             # 日志文件
*.pyc             # 编译缓存
```

## 脱敏规则

扫描 JSON 文件中的 key 名，包含以下关键词的 value 替换为 `__MIGRATE_PLACEHOLDER__`：
- apiKey / api_key
- secret / secretKey
- token / botToken / accessToken
- password
- privateKey / private_key
