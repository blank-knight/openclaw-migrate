const http = require('http');
const fs = require('fs');
const { CONTROL_PORT, CREDENTIALS_PATH, formatExpiry, maskToken } = require('./utils');

/**
 * 创建控制 API 服务器 (127.0.0.1:9877)。
 * 提供账号管理、状态查询、daemon 控制等接口。
 */
function createControlServer(tokenStore, options = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${CONTROL_PORT}`);
    const pathname = url.pathname;

    res.setHeader('Content-Type', 'application/json');

    try {
      // ── GET /status ────────────────────────────────
      if (req.method === 'GET' && pathname === '/status') {
        const active = tokenStore.getActiveAccount();
        const activeName = tokenStore.getActiveAccountName();
        return json(res, 200, {
          ok: true,
          activeAccount: activeName,
          tokenValid: active ? active.expiresAt > Date.now() : false,
          expiresAt: active ? active.expiresAt : null,
          expiresIn: active ? formatExpiry(active.expiresAt) : null,
          accountCount: Object.keys(tokenStore.config.accounts).length,
        });
      }

      // ── GET /accounts ──────────────────────────────
      if (req.method === 'GET' && pathname === '/accounts') {
        return json(res, 200, {
          ok: true,
          accounts: tokenStore.getAccounts(),
        });
      }

      // ── POST /switch ───────────────────────────────
      if (req.method === 'POST' && pathname === '/switch') {
        const body = await readBody(req);
        const { account } = JSON.parse(body);
        tokenStore.switchAccount(account);
        return json(res, 200, { ok: true, activeAccount: account });
      }

      // ── POST /import ───────────────────────────────
      if (req.method === 'POST' && pathname === '/import') {
        const body = await readBody(req);
        const { name, path: credPath } = JSON.parse(body);
        const filePath = credPath || CREDENTIALS_PATH;

        if (!fs.existsSync(filePath)) {
          return json(res, 400, {
            ok: false,
            error: `凭据文件不存在: ${filePath}`,
          });
        }

        let raw;
        try {
          raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
          return json(res, 400, {
            ok: false,
            error: `凭据文件解析失败: ${filePath}`,
          });
        }

        const oauth = raw.claudeAiOauth;
        if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
          return json(res, 400, {
            ok: false,
            error: '凭据文件中没有有效的 claudeAiOauth 数据',
          });
        }

        const account = tokenStore.importAccount(name, {
          ...oauth,
          importedFrom: filePath,
        });

        return json(res, 200, {
          ok: true,
          account: {
            name,
            subscriptionType: account.subscriptionType,
            tokenPrefix: maskToken(account.accessToken),
            expiresAt: account.expiresAt,
            expiresIn: formatExpiry(account.expiresAt),
          },
        });
      }

      // ── POST /refresh ──────────────────────────────
      if (req.method === 'POST' && pathname === '/refresh') {
        const body = await readBody(req);
        let accountName;
        try {
          accountName = JSON.parse(body).account;
        } catch {
          /* empty */
        }
        const name = accountName || tokenStore.getActiveAccountName();
        if (!name) {
          return json(res, 400, { ok: false, error: '没有指定或激活的账号' });
        }

        await tokenStore.refreshAccount(name);
        return json(res, 200, {
          ok: true,
          message: `账号 "${name}" 刷新成功`,
        });
      }

      // ── POST /stop ─────────────────────────────────
      if (req.method === 'POST' && pathname === '/stop') {
        json(res, 200, { ok: true, message: '正在停止 daemon...' });
        setTimeout(() => {
          if (options.onStop) options.onStop();
          else process.exit(0);
        }, 100);
        return;
      }

      // ── 404 ────────────────────────────────────────
      json(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      console.error(`[CTRL] ${req.method} ${pathname} 错误: ${err.message}`);
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: err.message });
      }
    }
  });

  return server;
}

// ── 辅助 ────────────────────────────────────────────────

function json(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { createControlServer };
