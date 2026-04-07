# 实施计划

## Phase 1: 文档 ✅ (当前)
- [x] program-design-document.md — 项目设计文档
- [x] strategy-research.md — 策略研究
- [x] tech-stack.md — 技术栈
- [x] architecture.md — 架构设计
- [x] implementation-plan.md — 实施计划

## Phase 2: 核心代码
- [ ] Step 1: `src/migrate.js` — 脱敏模块 (sanitize)
- [ ] Step 2: `src/migrate.js` — 远程环境检查 (checkRemote)
- [ ] Step 3: `src/migrate.js` — rsync 传输 (rsyncToRemote)
- [ ] Step 4: `src/migrate.js` — 远程部署 (deployRemote)
- [ ] Step 5: `src/migrate.js` — 完整迁移 (migrateFull)
- [ ] Step 6: `src/migrate.js` — 增量同步 (migrateSync)
- [ ] Step 7: `src/migrate.js` — 状态查询 (migrateStatus)
- [ ] Step 8: `src/migrate.js` — 环境诊断 (migrateDoctor)

## Phase 3: CLI 集成
- [ ] Step 9: 修改 `bin/ccs.js` — 添加 migrate 命令路由
- [ ] Step 10: 修改 `printHelp()` — 添加帮助文本

## Phase 4: 测试
- [ ] Step 11: 本地测试 dry-run 模式
- [ ] Step 12: 修改 README.md

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/migrate.js` | 迁移核心模块 (~350 行) |
| 修改 | `bin/ccs.js` | 添加 migrate 路由 (+80 行) |
| 修改 | `README.md` | 添加迁移文档 (+50 行) |
| 不动 | `src/http-proxy.js` | 原有功能不修改 |
| 不动 | `src/token-store.js` | 原有功能不修改 |
| 不动 | `src/daemon.js` | 原有功能不修改 |
| 不动 | `src/launcher.js` | 原有功能不修改 |
| 不动 | `src/control-server.js` | 原有功能不修改 |
| 不动 | `src/keepalive.js` | 原有功能不修改 |
