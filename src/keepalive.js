const fs = require('fs');
const {
  KEEPALIVE_PID_PATH,
  KEEPALIVE_LOG_PATH,
  ensureCcsDir,
} = require('./utils');
const TokenStore = require('./token-store');

// ── 日志 ────────────────────────────────────────────────

ensureCcsDir();
const logStream = fs.createWriteStream(KEEPALIVE_LOG_PATH, { flags: 'a' });

function writeLog(level, args) {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}\n`;
  logStream.write(msg);
}

console.log = (...args) => writeLog('INFO', args);
console.error = (...args) => writeLog('ERROR', args);

// ── PID 文件 ────────────────────────────────────────────

fs.writeFileSync(KEEPALIVE_PID_PATH, process.pid.toString(), 'utf8');

// ── 初始化 ──────────────────────────────────────────────

const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 分钟
const ONE_HOUR = 60 * 60 * 1000;

const tokenStore = new TokenStore();

// 启动时先做一次反向同步（从 Claude 凭据拉取新 token）
tokenStore.syncFromClaudeCredentials();

// 启动时立即做一次刷新检查
refreshAll();

// 定时刷新
const timer = setInterval(refreshAll, REFRESH_INTERVAL);

async function refreshAll() {
  tokenStore.reloadIfChanged();
  const accounts = tokenStore.config.accounts;

  for (const name of Object.keys(accounts)) {
    const account = accounts[name];
    if (account.expiresAt && account.expiresAt - Date.now() < ONE_HOUR) {
      try {
        await tokenStore.refreshAccount(name);
        console.log(`保活刷新账号 "${name}" 成功`);
      } catch (err) {
        console.error(`保活刷新账号 "${name}" 失败: ${err.message}`);
      }
    }
  }
}

// ── 清理 ────────────────────────────────────────────────

function cleanup() {
  console.log('Keepalive 收到停止信号，正在退出...');
  clearInterval(timer);
  try {
    fs.unlinkSync(KEEPALIVE_PID_PATH);
  } catch {
    /* ignore */
  }
  console.log('Keepalive 已退出');
  logStream.end(() => process.exit(0));
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

process.on('uncaughtException', (err) => {
  console.error(`未捕获异常: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (err) => {
  console.error(
    `未处理的 Promise 拒绝: ${err?.stack || err?.message || err}`,
  );
});

console.log(`CCS Keepalive 启动成功, PID: ${process.pid}, 刷新间隔: ${REFRESH_INTERVAL / 60000} 分钟`);
