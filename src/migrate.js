/**
 * migrate.js — OpenClaw 实例迁移模块
 *
 * 功能:
 *   - migrateFull:   完整迁移 (本地 → 远程服务器)
 *   - migrateSync:   增量同步 (只传变化的记忆文件)
 *   - migrateStatus: 查看远程 OpenClaw 状态
 *   - migrateDoctor: 诊断远程环境
 *
 * 零第三方依赖，仅使用 Node.js 内置模块
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// ──────────────────────────────────────────
//  常量
// ──────────────────────────────────────────

const OPENCLAW_DIR = path.join(HOME, '.openclaw');
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE || path.join(HOME, 'clawd');
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, 'openclaw.json');

const PLACEHOLDER = '__MIGRATE_PLACEHOLDER__';

// 脱敏关键词
const SENSITIVE_KEYS = [
  'apiKey', 'api_key', 'secret', 'secretKey',
  'token', 'botToken', 'bot_token', 'accessToken',
  'password', 'privateKey', 'private_key',
];

// rsync 排除规则
const EXCLUDE_PATTERNS = [
  '.env',
  '.env.*',
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '*.db',
  '*.db-journal',
  '*.log',
  '*.pyc',
  '.DS_Store',
  'memory-bank',        // 开发文档，不需要迁移
  'resume-*',           // 简历文件
  'claude-code-account-switch', // CCS 项目本身
  'polymarket-*',       // 交易 Bot
  'new-api',            // TokenGo
  'llm-agent-trading-bot',
];

// 必须迁移的文件
const MUST_HAVE_FILES = [
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
];

// 必须迁移的目录
const MUST_HAVE_DIRS = [
  'memory',
  'skills',
];


// ──────────────────────────────────────────
//  工具函数
// ──────────────────────────────────────────

function sshExec(userHost, cmd, timeout = 30000) {
  const [user, host] = userHost.split('@');
  if (!user || !host) {
    throw new Error(`无效的 SSH 地址: ${userHost}，格式应为 user@host`);
  }

  try {
    const result = execSync(`ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${userHost} "${cmd.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    if (err.killed) {
      throw new Error(`SSH 命令超时 (${timeout}ms): ${cmd}`);
    }
    throw new Error(`SSH 命令失败: ${err.stderr || err.message}`);
  }
}

function sanitize(obj) {
  const sanitized = JSON.parse(JSON.stringify(obj));

  function walk(node) {
    if (typeof node !== 'object' || node === null) return;

    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.some(sk => lower.includes(sk.toLowerCase()))) {
        if (typeof node[key] === 'string' && node[key].length > 0) {
          node[key] = PLACEHOLDER;
        }
      } else if (typeof node[key] === 'object') {
        walk(node[key]);
      }
    }
  }

  walk(sanitized);
  return sanitized;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


// ──────────────────────────────────────────
//  完整迁移
// ──────────────────────────────────────────

async function migrateFull(userHost, options = {}) {
  const remotePath = options.remotePath || '~/clawd';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   OpenClaw 一键迁移                     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`   目标: ${userHost}:${remotePath}`);
  console.log('');

  // ── Step 1: 本地检查 ──
  console.log('🔍 Step 1/6: 检查本地环境...');
  const localCheck = checkLocal();
  if (!localCheck.ok) {
    console.error(`❌ 本地检查失败: ${localCheck.error}`);
    process.exit(1);
  }
  console.log(`   ✅ 工作区: ${WORKSPACE_DIR}`);
  console.log(`   ✅ 配置: ${OPENCLAW_CONFIG}`);

  // ── Step 2: 远程环境检查 ──
  console.log('\n🔍 Step 2/6: 检查远程环境...');
  const remoteCheck = checkRemoteEnv(userHost);
  if (!remoteCheck.ok) {
    console.error(`❌ 远程检查失败: ${remoteCheck.error}`);
    process.exit(1);
  }
  console.log(`   ✅ Node.js: ${remoteCheck.nodeVersion}`);
  console.log(`   ✅ rsync: ${remoteCheck.rsync ? '已安装' : '未安装 (将使用 scp)'}`);
  console.log(`   ✅ 磁盘: ${remoteCheck.diskFree} 可用`);

  // ── Step 3: 脱敏 + 打包 ──
  console.log('\n📦 Step 3/6: 准备文件...');
  const sanitizeReport = prepareFiles(options);
  console.log(`   ✅ 必须文件: ${sanitizeReport.mustFiles} 个`);
  console.log(`   ✅ 记忆文件: ${sanitizeReport.memoryFiles} 个`);
  console.log(`   ✅ 技能文件: ${sanitizeReport.skillFiles} 个`);

  if (sanitizeReport.sanitizedKeys.length > 0) {
    console.log(`   ⚠️  脱敏字段: ${sanitizeReport.sanitizedKeys.join(', ')}`);
  }

  // ── Step 4: 传输 ──
  console.log('\n📤 Step 4/6: 传输文件到远程...');
  if (options.dryRun) {
    console.log('   🏃 dry-run 模式，跳过传输');
  } else {
    transferFiles(userHost, remotePath, options);
    console.log('   ✅ 传输完成');
  }

  // ── Step 5: 远程部署 ──
  console.log('\n⚙️  Step 5/6: 远程部署...');
  if (options.dryRun) {
    console.log('   🏃 dry-run 模式，跳过部署');
  } else {
    deployRemote(userHost, remotePath);
    console.log('   ✅ 部署完成');
  }

  // ── Step 6: 验证 ──
  console.log('\n✅ Step 6/6: 验证...');
  if (options.dryRun) {
    console.log('   🏃 dry-run 模式，跳过验证');
  } else {
    const verify = verifyRemote(userHost, remotePath);
    if (verify.ok) {
      console.log('   ✅ 远程 OpenClaw 运行正常');
    } else {
      console.log(`   ⚠️  验证失败: ${verify.error}`);
    }
  }

  // ── 报告 ──
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   🎉 迁移完成!                          ║');
  console.log('╚══════════════════════════════════════════╝');

  if (sanitizeReport.sanitizedKeys.length > 0) {
    console.log('\n⚠️  需要在远程手动配置以下内容:');
    console.log(`   1. SSH 到远程: ssh ${userHost}`);
    console.log(`   2. 编辑配置: nano ${remotePath}/openclaw.json`);
    console.log('   3. 将 __MIGRATE_PLACEHOLDER__ 替换为真实 API Key');
    console.log(`   4. 重启: openclaw gateway restart`);
    console.log('');
    console.log('   需要配置的字段:');
    sanitizeReport.sanitizedKeys.forEach(key => {
      console.log(`   - ${key}`);
    });
  }
}


// ──────────────────────────────────────────
//  增量同步
// ──────────────────────────────────────────

async function migrateSync(userHost, options = {}) {
  const remotePath = options.remotePath || '~/clawd';

  console.log('🔄 增量同步记忆文件...');
  console.log(`   目标: ${userHost}:${remotePath}`);
  console.log('');

  // 同步 memory 目录
  const memoryDir = path.join(WORKSPACE_DIR, 'memory');
  if (fs.existsSync(memoryDir)) {
    const excludeArgs = EXCLUDE_PATTERNS.map(e => `--exclude='${e}'`).join(' ');
    const cmd = `rsync -avz --dry-run=${options.dryRun ? '' : 'false'} ${excludeArgs} --include='*.md' "${memoryDir}/" "${userHost}:${remotePath}/memory/"`;

    if (options.dryRun) {
      console.log('   🏃 dry-run 模式，预览变更:');
      try {
        const result = execSync(cmd.replace('--dry-run=false', '-n'), { encoding: 'utf8' });
        console.log(result);
      } catch (err) {
        console.error(`   ❌ rsync 预览失败: ${err.message}`);
      }
    } else {
      try {
        execSync(`rsync -avz ${excludeArgs} "${memoryDir}/" "${userHost}:${remotePath}/memory/"`, {
          encoding: 'utf8',
          timeout: 60000,
        });
        console.log('   ✅ memory/ 同步完成');
      } catch (err) {
        console.error(`   ❌ memory/ 同步失败: ${err.message}`);
      }
    }
  }

  // 同步关键文件
  const syncFiles = ['SOUL.md', 'MEMORY.md', 'HEARTBEAT.md'];
  for (const file of syncFiles) {
    const localPath = path.join(WORKSPACE_DIR, file);
    if (fs.existsSync(localPath)) {
      if (!options.dryRun) {
        try {
          execSync(`scp -q "${localPath}" "${userHost}:${remotePath}/${file}"`, {
            encoding: 'utf8',
            timeout: 30000,
          });
          console.log(`   ✅ ${file} 同步完成`);
        } catch (err) {
          console.error(`   ❌ ${file} 同步失败: ${err.message}`);
        }
      } else {
        console.log(`   🏃 ${file} (dry-run)`);
      }
    }
  }

  if (!options.dryRun) {
    console.log('\n✅ 增量同步完成!');
  }
}


// ──────────────────────────────────────────
//  远程状态查询
// ──────────────────────────────────────────

async function migrateStatus(userHost) {
  console.log(`📊 远程 OpenClaw 状态: ${userHost}`);
  console.log('');

  try {
    // OpenClaw 版本
    const version = sshExec(userHost, 'openclaw --version 2>/dev/null || echo "未安装"');
    console.log(`   OpenClaw 版本: ${version}`);

    // Gateway 状态
    const gwStatus = sshExec(userHost, 'openclaw gateway status 2>/dev/null || echo "未运行"');
    console.log(`   Gateway 状态: ${gwStatus.split('\n')[0]}`);

    // 工作区文件
    const workspace = sshExec(userHost, 'ls ~/clawd/*.md 2>/dev/null | wc -l');
    console.log(`   工作区文件: ${workspace} 个 .md 文件`);

    const memoryCount = sshExec(userHost, 'ls ~/clawd/memory/*.md 2>/dev/null | wc -l');
    console.log(`   记忆文件: ${memoryCount} 个`);

    // 磁盘
    const disk = sshExec(userHost, 'df -h ~ | tail -1 | awk \'{print $4}\'');
    console.log(`   磁盘可用: ${disk}`);

  } catch (err) {
    console.error(`❌ 状态查询失败: ${err.message}`);
  }
}


// ──────────────────────────────────────────
//  环境诊断
// ──────────────────────────────────────────

async function migrateDoctor(userHost) {
  let allOk = true;

  console.log('=== CCS 迁移诊断 ===\n');

  // ── 本地检查 ──
  console.log('📦 本地环境:');
  const local = checkLocal();
  if (local.ok) {
    console.log(`  ✅ 工作区: ${WORKSPACE_DIR}`);
    console.log(`  ✅ 配置: ${OPENCLAW_CONFIG}`);
  } else {
    console.log(`  ❌ ${local.error}`);
    allOk = false;
  }

  // rsync
  try {
    execSync('which rsync', { encoding: 'utf8' });
    console.log('  ✅ rsync: 已安装');
  } catch {
    console.log('  ❌ rsync: 未安装');
    allOk = false;
  }

  // ssh
  try {
    execSync('which ssh', { encoding: 'utf8' });
    console.log('  ✅ ssh: 已安装');
  } catch {
    console.log('  ❌ ssh: 未安装');
    allOk = false;
  }

  // SSH 连通性
  if (userHost) {
    console.log('\n🌐 远程连接:');
    try {
      sshExec(userHost, 'echo ok', 10000);
      console.log(`  ✅ SSH 连接: ${userHost}`);

      const remote = checkRemoteEnv(userHost);
      if (remote.ok) {
        console.log(`  ✅ Node.js: ${remote.nodeVersion}`);
        console.log(`  ✅ 磁盘可用: ${remote.diskFree}`);
      } else {
        console.log(`  ❌ 远程环境: ${remote.error}`);
        allOk = false;
      }
    } catch (err) {
      console.log(`  ❌ SSH 连接失败: ${err.message}`);
      allOk = false;
    }
  }

  console.log('');
  if (allOk) {
    console.log('✅ 诊断通过，可以迁移!');
  } else {
    console.log('⚠️  存在问题，请检查上面的错误。');
  }
}


// ──────────────────────────────────────────
//  内部函数
// ──────────────────────────────────────────

function checkLocal() {
  // 检查工作区
  if (!fs.existsSync(WORKSPACE_DIR)) {
    return { ok: false, error: `工作区不存在: ${WORKSPACE_DIR}` };
  }

  // 检查关键文件
  const missing = MUST_HAVE_FILES.filter(
    f => !fs.existsSync(path.join(WORKSPACE_DIR, f))
  );
  if (missing.length > 0 && missing.length === MUST_HAVE_FILES.length) {
    return { ok: false, error: `工作区缺少所有关键文件: ${missing.join(', ')}` };
  }

  // 检查 openclaw 配置
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    return { ok: false, error: `OpenClaw 配置不存在: ${OPENCLAW_CONFIG}` };
  }

  return { ok: true };
}

function checkRemoteEnv(userHost) {
  try {
    // Node.js 版本
    const nodeVersion = sshExec(userHost, 'node --version 2>/dev/null || echo "not found"');
    if (nodeVersion.includes('not found')) {
      return { ok: false, error: '远程未安装 Node.js' };
    }

    const major = parseInt(nodeVersion.replace('v', '').split('.')[0]);
    if (major < 18) {
      return { ok: false, error: `远程 Node.js 版本过低: ${nodeVersion}，需要 >= 18` };
    }

    // rsync
    const rsync = !sshExec(userHost, 'which rsync 2>/dev/null || echo "no"').includes('no');

    // 磁盘空间
    const diskFree = sshExec(userHost, 'df -h ~ | tail -1 | awk \'{print $4}\'');

    return { ok: true, nodeVersion, rsync, diskFree };
  } catch (err) {
    return { ok: false, error: `远程连接失败: ${err.message}` };
  }
}

function prepareFiles(options) {
  const report = {
    mustFiles: 0,
    memoryFiles: 0,
    skillFiles: 0,
    sanitizedKeys: [],
  };

  // 统计必须文件
  for (const f of MUST_HAVE_FILES) {
    if (fs.existsSync(path.join(WORKSPACE_DIR, f))) {
      report.mustFiles++;
    }
  }

  // 统计 memory 文件
  const memoryDir = path.join(WORKSPACE_DIR, 'memory');
  if (fs.existsSync(memoryDir)) {
    report.memoryFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).length;
  }

  // 统计 skills 文件
  const skillsDir = path.join(WORKSPACE_DIR, 'skills');
  if (fs.existsSync(skillsDir)) {
    report.skillFiles = countFilesRecursive(skillsDir);
  }

  // 脱敏检查 openclaw.json
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    const raw = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    report.sanitizedKeys = findSensitiveKeys(raw);
  }

  return report;
}

function findSensitiveKeys(obj, prefix = '') {
  const found = [];
  if (typeof obj !== 'object' || obj === null) return found;

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const lower = key.toLowerCase();

    if (SENSITIVE_KEYS.some(sk => lower.includes(sk.toLowerCase()))) {
      if (typeof value === 'string' && value.length > 0 && value !== PLACEHOLDER) {
        found.push(fullPath);
      }
    }

    if (typeof value === 'object' && value !== null) {
      found.push(...findSensitiveKeys(value, fullPath));
    }
  }
  return found;
}

function transferFiles(userHost, remotePath, options) {
  // 创建远程目录
  sshExec(userHost, `mkdir -p ${remotePath}/memory ${remotePath}/skills`);

  // 构建 rsync 命令
  const excludeArgs = EXCLUDE_PATTERNS
    .map(p => `--exclude='${p}'`)
    .join(' ');

  const cmd = `rsync -avz ${excludeArgs} "${WORKSPACE_DIR}/" "${userHost}:${remotePath}/"`;

  try {
    execSync(cmd, {
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // rsync 失败，尝试 scp fallback
    console.log('   ⚠️  rsync 失败，尝试 scp...');
    scpFallback(userHost, remotePath);
  }

  // 单独传输脱敏后的 openclaw 配置
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    const raw = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    const sanitized = sanitize(raw);

    const tmpFile = path.join(os.tmpdir(), 'openclaw-sanitized.json');
    fs.writeFileSync(tmpFile, JSON.stringify(sanitized, null, 2));

    execSync(`scp -q "${tmpFile}" "${userHost}:${remotePath}/openclaw.json`, {
      encoding: 'utf8',
      timeout: 30000,
    });

    // 清理临时文件
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function scpFallback(userHost, remotePath) {
  // 传输关键文件
  for (const f of MUST_HAVE_FILES) {
    const localPath = path.join(WORKSPACE_DIR, f);
    if (fs.existsSync(localPath)) {
      try {
        execSync(`scp -q "${localPath}" "${userHost}:${remotePath}/${f}"`, {
          encoding: 'utf8', timeout: 30000,
        });
      } catch (err) {
        console.error(`   ❌ ${f} 传输失败: ${err.message}`);
      }
    }
  }

  // 传输 memory 目录
  const memoryDir = path.join(WORKSPACE_DIR, 'memory');
  if (fs.existsSync(memoryDir)) {
    try {
      execSync(`scp -rq "${memoryDir}" "${userHost}:${remotePath}/"`, {
        encoding: 'utf8', timeout: 60000,
      });
    } catch (err) {
      console.error(`   ❌ memory/ 传输失败: ${err.message}`);
    }
  }

  // 传输 skills 目录
  const skillsDir = path.join(WORKSPACE_DIR, 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      execSync(`scp -rq "${skillsDir}" "${userHost}:${remotePath}/"`, {
        encoding: 'utf8', timeout: 60000,
      });
    } catch (err) {
      console.error(`   ❌ skills/ 传输失败: ${err.message}`);
    }
  }
}

function deployRemote(userHost, remotePath) {
  // 检查并安装 OpenClaw
  const openclawCheck = sshExec(
    userHost,
    'which openclaw 2>/dev/null || echo "not found"'
  );

  if (openclawCheck.includes('not found')) {
    console.log('   📦 安装 OpenClaw...');
    sshExec(userHost, 'npm install -g openclaw', 120000);
    console.log('   ✅ OpenClaw 安装完成');
  } else {
    console.log('   ✅ OpenClaw 已安装');
  }

  // 启动 Gateway
  console.log('   🚀 启动 OpenClaw Gateway...');
  try {
    sshExec(userHost, `cd ${remotePath} && openclaw gateway start`, 30000);
    console.log('   ✅ Gateway 已启动');
  } catch (err) {
    // 可能已经在运行
    console.log(`   ⚠️  Gateway 启动: ${err.message}`);
  }
}

function verifyRemote(userHost, remotePath) {
  try {
    // 检查关键文件
    const files = sshExec(
      userHost,
      `ls ${remotePath}/SOUL.md ${remotePath}/MEMORY.md ${remotePath}/memory 2>&1`
    );
    if (files.includes('No such file')) {
      return { ok: false, error: '关键文件缺失' };
    }

    // 检查 Gateway
    const status = sshExec(userHost, 'openclaw gateway status 2>/dev/null || echo "down"');
    if (status.includes('down')) {
      return { ok: false, error: 'Gateway 未运行' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function countFilesRecursive(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}


// ──────────────────────────────────────────
//  导出
// ──────────────────────────────────────────

module.exports = {
  migrateFull,
  migrateSync,
  migrateStatus,
  migrateDoctor,
};
