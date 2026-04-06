const fs = require('fs');
const {
  PID_PATH,
  LOG_PATH,
  PROXY_PORT,
  CONTROL_PORT,
  ensureCcsDir,
} = require('./utils');
const TokenStore = require('./token-store');
const { createProxyServer } = require('./http-proxy');
const { createControlServer } = require('./control-server');

// ── 日志 ────────────────────────────────────────────────

ensureCcsDir();
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function writeLog(level, args) {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}\n`;
  logStream.write(msg);
}

console.log = (...args) => writeLog('INFO', args);
console.error = (...args) => writeLog('ERROR', args);

// ── PID 文件 ────────────────────────────────────────────

fs.writeFileSync(PID_PATH, process.pid.toString(), 'utf8');

// ── 初始化 ──────────────────────────────────────────────

const tokenStore = new TokenStore();

const proxyServer = createProxyServer(tokenStore);
const controlServer = createControlServer(tokenStore, { onStop: cleanup });

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`代理服务已启动: http://127.0.0.1:${PROXY_PORT}`);
});

controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
  console.log(`控制服务已启动: http://127.0.0.1:${CONTROL_PORT}`);
});

// 启动后台 token 定时刷新
tokenStore.startBackgroundRefresh();

// ── 清理 ────────────────────────────────────────────────

function cleanup() {
  console.log('收到停止信号，正在关闭...');
  tokenStore.stopBackgroundRefresh();

  let closed = 0;
  const done = () => {
    closed++;
    if (closed >= 2) {
      try {
        fs.unlinkSync(PID_PATH);
      } catch {
        /* ignore */
      }
      console.log('Daemon 已退出');
      logStream.end(() => process.exit(0));
    }
  };

  proxyServer.close(done);
  controlServer.close(done);

  // 保底：5 秒后强制退出
  setTimeout(() => process.exit(0), 5000).unref();
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

console.log(`CCS Daemon 启动成功, PID: ${process.pid}`);
