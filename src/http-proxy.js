const http = require('http');
const https = require('https');
const { API_HOST } = require('./utils');

// HTTP hop-by-hop headers，不应被代理转发
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 创建反向代理服务器。
 * 把收到的所有请求转发到 https://api.anthropic.com，
 * 并将 auth header 替换为当前激活账号的真实 accessToken。
 *
 * 当上游返回 401 时，自动刷新 token 并重试一次，对 Claude Code 透明。
 */
function createProxyServer(tokenStore) {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const logPrefix = `[PROXY] ${req.method} ${req.url}`;

    // 先收集请求体（在 await 之前开始监听，防止数据丢失）
    const bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    const bodyReady = new Promise((resolve) => req.on('end', resolve));

    // 跟踪当前上游请求，客户端断开时取消
    let activeUpstream = null;
    res.on('close', () => {
      if (activeUpstream && !activeUpstream.destroyed) activeUpstream.destroy();
    });

    try {
      // 并行：等待 token + 请求体
      const [token] = await Promise.all([
        tokenStore.getActiveToken(),
        bodyReady,
      ]);

      const body = Buffer.concat(bodyChunks);

      // 构建上游请求 headers：跳过要覆盖的 + hop-by-hop headers
      const baseHeaders = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (
          lower === 'authorization' ||
          lower === 'x-api-key' ||
          lower === 'host' ||
          HOP_BY_HOP.has(lower)
        ) {
          continue;
        }
        baseHeaders[key] = value;
      }

      // 发送一次上游请求，返回响应对象
      const sendUpstream = (tkn) =>
        new Promise((resolve, reject) => {
          const headers = {
            ...baseHeaders,
            host: API_HOST,
            'x-api-key': tkn,
            'content-length': body.length,
          };
          const upstream = https.request(
            {
              hostname: API_HOST,
              port: 443,
              path: req.url,
              method: req.method,
              headers,
            },
            resolve,
          );
          upstream.on('error', reject);
          activeUpstream = upstream;
          upstream.end(body);
        });

      // ── 第一次请求 ──
      let proxyRes = await sendUpstream(token);
      console.log(
        `${logPrefix} -> ${proxyRes.statusCode} (${Date.now() - startTime}ms)`,
      );

      // ── 401 → "先看后刷"恢复策略 ──
      if (proxyRes.statusCode === 401) {
        proxyRes.resume(); // 丢弃 401 响应体
        const sentToken = token; // 记录本次发送的 token

        let recovered = false;

        // ① reload config：检查 keepalive 是否已刷新
        tokenStore.reloadIfChanged();
        const reloadedToken = tokenStore.getActiveAccount()?.accessToken;
        if (reloadedToken && reloadedToken !== sentToken) {
          console.log(`${logPrefix} 401 → config 中 token 已更新（keepalive），直接重试`);
          proxyRes = await sendUpstream(reloadedToken);
          recovered = proxyRes.statusCode !== 401;
        }

        // ② sync from credentials：检查 Claude Code 是否已刷新
        if (!recovered) {
          if (proxyRes.statusCode === 401) proxyRes.resume();
          if (tokenStore.syncActiveFromCredentials({ force: true })) {
            const syncedToken = tokenStore.getActiveAccount()?.accessToken;
            if (syncedToken && syncedToken !== sentToken) {
              console.log(`${logPrefix} 401 → 从 credentials 同步成功，重试`);
              proxyRes = await sendUpstream(syncedToken);
              recovered = proxyRes.statusCode !== 401;
            }
          }
        }

        // ③ 最后才尝试 OAuth refresh
        if (!recovered) {
          if (proxyRes.statusCode === 401) proxyRes.resume();
          console.log(`${logPrefix} 401 → 尝试 OAuth refresh...`);
          try {
            await tokenStore.refreshAccount(tokenStore.getActiveAccountName());
            const newToken = await tokenStore.getActiveToken();
            proxyRes = await sendUpstream(newToken);
            console.log(
              `${logPrefix} OAuth 刷新重试 -> ${proxyRes.statusCode} (${Date.now() - startTime}ms)`,
            );
          } catch (err) {
            console.error(`${logPrefix} 401 全部恢复策略失败: ${err.message}`);
            if (!res.headersSent) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'authentication_error',
                    message: 'Token refresh failed: ' + err.message,
                  },
                }),
              );
            }
            return;
          }
        }

        if (recovered) {
          console.log(
            `${logPrefix} 401 恢复成功 -> ${proxyRes.statusCode} (${Date.now() - startTime}ms)`,
          );
        }
      }

      // ── 转发响应（包括 SSE 流式） ──
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    } catch (err) {
      console.error(`${logPrefix} 处理错误: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  return server;
}

module.exports = { createProxyServer };
