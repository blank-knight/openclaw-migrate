const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const {
  PROXY_PORT,
  CONTROL_PORT,
  PID_PATH,
  CONFIG_PATH,
  findClaudeExe,
} = require('./utils');

function checkDaemonReady() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: CONTROL_PORT,
        path: '/status',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function ensureDaemon() {
  if (await checkDaemonReady()) return;

  // 清除残留 PID 文件
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }

  // 以 detached 模式启动 daemon
  const daemonPath = path.join(__dirname, 'daemon.js');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // 轮询等待就绪（最多 10 秒）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await checkDaemonReady()) return;
  }

  throw new Error('Daemon 启动超时，请查看日志: ~/.ccs/daemon.log');
}

async function launchClaude(args) {
  // 1. 找到 claude.exe
  const claudePath = findClaudeExe();
  if (!claudePath) {
    console.error(
      '❌ 找不到 claude.exe，请确认 Claude Code 已安装并在 PATH 中。',
    );
    process.exit(1);
  }

  // 2. 检查是否有已导入的账号
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (
        !config.activeAccount ||
        !config.accounts[config.activeAccount]
      ) {
        console.error(
          '❌ 没有激活的账号。请先导入并切换账号：\n' +
            '   ccs import <名称>\n' +
            '   ccs switch <名称>',
        );
        process.exit(1);
      }
    } catch {
      /* 配置损坏，后续 daemon 会报错 */
    }
  } else {
    console.error(
      '❌ 尚未导入任何账号。请先执行：\n   ccs import <名称>',
    );
    process.exit(1);
  }

  // 3. 确保 daemon 运行
  process.stdout.write('🔄 正在启动 CCS daemon...');
  await ensureDaemon();
  console.log(' ✅');

  // 4. 启动 claude.exe，注入代理环境变量
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
    ANTHROPIC_AUTH_TOKEN: 'dummy-token-proxy-will-replace',
  };

  const child = spawn(claudePath, args, {
    stdio: 'inherit',
    env,
    shell: false,
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error(`❌ 启动 claude.exe 失败: ${err.message}`);
    process.exit(1);
  });

  // 转发信号
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
}

module.exports = { launchClaude, ensureDaemon, checkDaemonReady };
