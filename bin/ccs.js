#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');

const srcDir = path.join(__dirname, '..', 'src');
const {
  CREDENTIALS_PATH,
  CONFIG_PATH,
  CCS_DIR,
  CONTROL_PORT,
  API_HOST,
  PLATFORM_HOST,
  ensureCcsDir,
  findClaudeExe,
  callControlApi,
  formatExpiry,
  maskToken,
} = require(path.join(srcDir, 'utils'));

const args = process.argv.slice(2);
const command = args[0];

const MANAGEMENT_COMMANDS = [
  'import',
  'switch',
  'status',
  'accounts',
  'doctor',
  'stop',
  'keepalive',
];
const BLOCKED_COMMANDS = ['auth', 'login', '/login', 'logout', '/logout'];

// ── 入口 ────────────────────────────────────────────────

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (BLOCKED_COMMANDS.includes(command)) {
    console.error(
      '⚠️  请先退出 ccs 代理模式，在原版 claude 中使用 /login 或 /logout 命令。',
    );
    process.exit(1);
  }

  if (MANAGEMENT_COMMANDS.includes(command)) {
    await handleManagement(command, args.slice(1));
  } else {
    // 启动 Claude Code
    let claudeArgs = args;
    if (command === 'claude') {
      claudeArgs = args.slice(1);
    }
    const { launchClaude } = require(path.join(srcDir, 'launcher'));
    await launchClaude(claudeArgs);
  }
}

// ── 管理命令路由 ────────────────────────────────────────

async function handleManagement(cmd, cmdArgs) {
  switch (cmd) {
    case 'import':
      return handleImport(cmdArgs);
    case 'switch':
      return handleSwitch(cmdArgs);
    case 'status':
      return handleStatus();
    case 'accounts':
      return handleAccounts();
    case 'doctor':
      return handleDoctor();
    case 'stop':
      return handleStop();
    case 'keepalive':
      return handleKeepalive(cmdArgs);
  }
}

// ── import ──────────────────────────────────────────────

async function handleImport(cmdArgs) {
  const name = cmdArgs[0];
  if (!name) {
    console.error('用法: ccs import <账号名> [凭据文件路径]');
    process.exit(1);
  }

  const credPath = cmdArgs[1] || CREDENTIALS_PATH;

  // 先尝试通过 daemon
  try {
    const res = await callControlApi('POST', '/import', {
      name,
      path: credPath,
    });
    const data = JSON.parse(res.body);
    if (data.ok) {
      printImportResult(name, data.account);
      await autoStartKeepalive();
      return;
    }
    console.error(`❌ ${data.error}`);
    process.exit(1);
  } catch {
    // daemon 未运行，本地执行
  }

  // 本地导入
  if (!fs.existsSync(credPath)) {
    console.error(`❌ 凭据文件不存在: ${credPath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    console.error(`❌ 凭据文件解析失败: ${credPath}`);
    process.exit(1);
  }

  const oauth = raw.claudeAiOauth;
  if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
    console.error('❌ 凭据文件中没有有效的 claudeAiOauth 数据');
    process.exit(1);
  }

  const TokenStore = require(path.join(srcDir, 'token-store'));
  const store = new TokenStore();

  // 查重：检查 token 是否已属于另一个账号
  const dup = store.findDuplicateToken(name, oauth.accessToken);
  if (dup) {
    console.error(`❌ 该凭据已导入为账号 "${dup}"，不能重复导入为 "${name}"。`);
    console.error(`   如需更新 "${name}"，请先在 Claude 中登录对应账号再导入。`);
    process.exit(1);
  }

  const account = store.importAccount(name, {
    ...oauth,
    importedFrom: credPath,
  });

  printImportResult(name, {
    subscriptionType: account.subscriptionType,
    tokenPrefix: maskToken(account.accessToken),
    expiresAt: account.expiresAt,
    expiresIn: formatExpiry(account.expiresAt),
  });
  console.log(`   ℹ️  本地模式（daemon 未运行）`);

  await autoStartKeepalive();
}

function printImportResult(name, info) {
  console.log(`✅ 账号 "${name}" 导入成功`);
  console.log(`   订阅类型: ${info.subscriptionType}`);
  console.log(`   Token:    ${info.tokenPrefix}`);
  console.log(`   过期时间: ${info.expiresIn}`);
}

// ── switch ──────────────────────────────────────────────

async function handleSwitch(cmdArgs) {
  const name = cmdArgs[0];
  if (!name) {
    console.error('用法: ccs switch <账号名>');
    process.exit(1);
  }

  // 先尝试 daemon
  try {
    const res = await callControlApi('POST', '/switch', { account: name });
    const data = JSON.parse(res.body);
    if (data.ok) {
      console.log(`✅ 已切换到账号 "${name}"，下一次请求生效。`);
      return;
    }
    console.error(`❌ ${data.error}`);
    process.exit(1);
  } catch {
    // daemon 未运行
  }

  // 本地切换
  const TokenStore = require(path.join(srcDir, 'token-store'));
  const store = new TokenStore();
  try {
    store.switchAccount(name);
    console.log(`✅ 已切换到账号 "${name}"（本地模式，daemon 未运行）。`);
    console.log(`   使用 ccs 启动 Claude 时会自动启动 daemon。`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

// ── status ──────────────────────────────────────────────

async function handleStatus() {
  console.log('=== CCS 状态 ===');

  try {
    const res = await callControlApi('GET', '/status');
    const data = JSON.parse(res.body);
    console.log('Daemon:     运行中');
    console.log(`当前账号:   ${data.activeAccount || '未设置'}`);
    console.log(`Token 有效: ${data.tokenValid ? '是' : '否'}`);
    console.log(`过期时间:   ${data.expiresIn || 'N/A'}`);
    console.log(`已导入账号: ${data.accountCount} 个`);
  } catch {
    console.log('Daemon:     未运行');
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        console.log(`当前账号:   ${config.activeAccount || '未设置'}`);
        console.log(
          `已导入账号: ${Object.keys(config.accounts).length} 个`,
        );
      } catch {
        /* ignore */
      }
    }
  }
}

// ── accounts ────────────────────────────────────────────

async function handleAccounts() {
  let accounts;
  let daemonRunning = false;

  try {
    const res = await callControlApi('GET', '/accounts');
    const data = JSON.parse(res.body);
    accounts = data.accounts;
    daemonRunning = true;
  } catch {
    // 本地读取
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        accounts = {};
        for (const [name, acc] of Object.entries(config.accounts)) {
          accounts[name] = {
            subscriptionType: acc.subscriptionType,
            isActive: name === config.activeAccount,
            expiresAt: acc.expiresAt,
            tokenPrefix: acc.accessToken
              ? acc.accessToken.substring(0, 16)
              : 'N/A',
          };
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!accounts || Object.keys(accounts).length === 0) {
    console.log('暂无已导入的账号。请使用 ccs import <名称> 导入账号。');
    return;
  }

  const daemonStatus = daemonRunning ? 'Daemon: 运行中 ✅' : 'Daemon: 未运行';
  console.log(`=== 已导入账号 === (${daemonStatus})`);
  for (const [name, info] of Object.entries(accounts)) {
    const marker = info.isActive ? ' (当前)' : '';
    console.log(`\n  ${name}${marker}`);
    console.log(`    订阅类型: ${info.subscriptionType}`);
    console.log(`    Token:    ${info.tokenPrefix}...`);
    console.log(`    过期时间: ${formatExpiry(info.expiresAt)}`);
  }
}

// ── doctor ──────────────────────────────────────────────

async function handleDoctor() {
  console.log('=== CCS 诊断 ===\n');
  let allOk = true;

  // 1. claude.exe
  const claudePath = findClaudeExe();
  if (claudePath) {
    console.log(`✅ claude.exe: ${claudePath}`);
  } else {
    console.log('❌ claude.exe: 未找到');
    allOk = false;
  }

  // 2. 配置文件
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const count = Object.keys(config.accounts).length;
      if (count > 0) {
        console.log(`✅ 已导入账号: ${count} 个`);
      } else {
        console.log('⚠️  暂无已导入的账号');
      }
    } catch {
      console.log('❌ 配置文件损坏');
      allOk = false;
    }
  } else {
    console.log('ℹ️  配置文件不存在（首次使用时会自动创建）');
  }

  // 4. Daemon 状态
  const daemonRunning = await isDaemonRunningAsync();
  if (daemonRunning) {
    console.log('✅ Daemon: 运行中');
  } else {
    console.log('ℹ️  Daemon: 未运行（使用 ccs 启动 Claude 时会自动启动）');
  }

  // 4.5 Keepalive 状态
  if (isKeepaliveRunning()) {
    const pid = fs.readFileSync(KEEPALIVE_PID_PATH, 'utf8').trim();
    console.log(`✅ Keepalive: 运行中 (PID: ${pid})`);
  } else {
    console.log('ℹ️  Keepalive: 未运行（使用 ccs keepalive 启动，或 import 时自动启动）');
  }

  // 5. 网络连通性
  process.stdout.write('🔍 检查 api.anthropic.com...');
  const apiOk = await checkConnectivity(API_HOST);
  console.log(apiOk ? ' ✅ 可连接' : ' ❌ 无法连接');
  if (!apiOk) allOk = false;

  process.stdout.write('🔍 检查 platform.claude.com (token 刷新)...');
  const platformOk = await checkConnectivity(PLATFORM_HOST);
  console.log(platformOk ? ' ✅ 可连接' : ' ❌ 无法连接');
  if (!platformOk) allOk = false;

  // 6. 端口检查
  if (!daemonRunning) {
    const p1 = await checkPortAvailable(9876);
    const p2 = await checkPortAvailable(9877);
    console.log(
      p1
        ? '✅ 端口 9876 (代理): 可用'
        : '❌ 端口 9876 (代理): 被占用',
    );
    console.log(
      p2
        ? '✅ 端口 9877 (控制): 可用'
        : '❌ 端口 9877 (控制): 被占用',
    );
    if (!p1 || !p2) allOk = false;
  } else {
    console.log('✅ 端口 9876 (代理): daemon 占用中');
    console.log('✅ 端口 9877 (控制): daemon 占用中');
  }

  console.log('');
  if (allOk) {
    console.log('✅ 诊断完成，一切正常！');
  } else {
    console.log('⚠️  诊断完成，存在问题，请检查上面的错误。');
  }
}

// ── stop ────────────────────────────────────────────────

async function handleStop() {
  try {
    const res = await callControlApi('POST', '/stop');
    const data = JSON.parse(res.body);
    if (data.ok) {
      console.log('✅ Daemon 正在停止...');
      return;
    }
  } catch {
    /* fall through */
  }
  console.log('ℹ️  Daemon 未在运行。');
}

// ── keepalive ──────────────────────────────────────────

const { KEEPALIVE_PID_PATH } = require(path.join(srcDir, 'utils'));
const { spawn } = require('child_process');

function isKeepaliveRunning() {
  try {
    if (!fs.existsSync(KEEPALIVE_PID_PATH)) return false;
    const pid = parseInt(fs.readFileSync(KEEPALIVE_PID_PATH, 'utf8').trim(), 10);
    process.kill(pid, 0); // 检查进程是否存在
    return true;
  } catch {
    // 进程不存在，清理残留 PID 文件
    try { fs.unlinkSync(KEEPALIVE_PID_PATH); } catch { /* ignore */ }
    return false;
  }
}

function startKeepaliveProcess() {
  const keepalivePath = path.join(srcDir, 'keepalive.js');
  const child = spawn(process.execPath, [keepalivePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function stopKeepaliveProcess() {
  try {
    if (!fs.existsSync(KEEPALIVE_PID_PATH)) return false;
    const pid = parseInt(fs.readFileSync(KEEPALIVE_PID_PATH, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    try { fs.unlinkSync(KEEPALIVE_PID_PATH); } catch { /* ignore */ }
    return true;
  } catch {
    try { fs.unlinkSync(KEEPALIVE_PID_PATH); } catch { /* ignore */ }
    return false;
  }
}

async function handleKeepalive(cmdArgs) {
  const subCmd = cmdArgs[0];

  if (subCmd === 'stop') {
    if (stopKeepaliveProcess()) {
      console.log('✅ Keepalive 已停止');
    } else {
      console.log('ℹ️  Keepalive 未在运行');
    }
    return;
  }

  if (subCmd === 'status') {
    if (isKeepaliveRunning()) {
      const pid = fs.readFileSync(KEEPALIVE_PID_PATH, 'utf8').trim();
      console.log(`✅ Keepalive 运行中 (PID: ${pid})`);
    } else {
      console.log('ℹ️  Keepalive 未在运行');
    }
    return;
  }

  // 默认：启动
  if (isKeepaliveRunning()) {
    const pid = fs.readFileSync(KEEPALIVE_PID_PATH, 'utf8').trim();
    console.log(`ℹ️  Keepalive 已在运行 (PID: ${pid})`);
    return;
  }

  const pid = startKeepaliveProcess();
  // 等待 PID 文件出现，确认启动成功
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(KEEPALIVE_PID_PATH)) {
      console.log(`✅ Keepalive 已启动 (PID: ${pid})，token 将自动保持活跃`);
      return;
    }
  }
  console.error('❌ Keepalive 启动超时，请查看日志: ~/.ccs/keepalive.log');
  process.exit(1);
}

/** import 完成后自动启动 keepalive（如果未运行） */
async function autoStartKeepalive() {
  if (isKeepaliveRunning()) return;

  startKeepaliveProcess();
  // 等待启动
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(KEEPALIVE_PID_PATH)) {
      console.log('🔄 Keepalive 已自动启动，token 将保持活跃');
      return;
    }
  }
}

// ── help ────────────────────────────────────────────────

function printHelp() {
  console.log(`
Claude Code 账户切换器 (ccs) v1.1.0

用法:
  ccs [claude] [args...]          启动代理模式的 Claude Code
  ccs import <名称> [路径]        导入账号（默认读取 ~/.claude/.credentials.json）
  ccs switch <名称>               切换当前账号（下一次请求生效）
  ccs status                      查看当前状态
  ccs accounts                    列出所有已导入账号
  ccs keepalive                   启动 token 保活服务（import 后自动启动）
  ccs keepalive stop              停止 token 保活服务
  ccs keepalive status            查看保活服务状态
  ccs doctor                      诊断检查
  ccs stop                        停止后台 daemon

示例:
  ccs import account_a                            从默认位置导入
  ccs import account_b "C:\\path\\.credentials.json"  从指定路径导入
  ccs claude --dangerously-skip-permissions        启动 Claude Code（代理模式）
  ccs --dangerously-skip-permissions               同上
  ccs switch account_b                             切换到账号 B
  ccs status                                       查看状态
  ccs keepalive                                    启动 token 保活
`);
}

// ── 辅助函数 ────────────────────────────────────────────

async function isDaemonRunningAsync() {
  try {
    const res = await callControlApi('GET', '/status');
    return JSON.parse(res.body).ok === true;
  } catch {
    return false;
  }
}

function checkConnectivity(host) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: host, port: 443, path: '/', method: 'HEAD', timeout: 10000 },
      () => resolve(true),
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

// ── 运行 ────────────────────────────────────────────────

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
