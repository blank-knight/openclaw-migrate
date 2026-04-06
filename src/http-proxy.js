const http = require('http');
const https = require('https');
const { PROXY_PORT, API_HOST } = require('./utils');

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
 * 把 127.0.0.1:9876 上收到的所有请求转发到 https://api.anthropic.com，
 * 并将 Authorization header 替换为当前激活账号的真实 accessToken。
 */
function createProxyServer(tokenStore) {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const logPrefix = `[PROXY] ${req.method} ${req.url}`;

    // 先收集请求体（在 await 之前开始监听，防止数据丢失）
    const bodyChunks = [];
    req.on('data', (chunk) => bodyChunks.push(chunk));
    const bodyReady = new Promise((resolve) => req.on('end', resolve));

    try {
      // 并行：等待 token + 请求体
      const [token] = await Promise.all([
        tokenStore.getActiveToken(),
        bodyReady,
      ]);

      const body = Buffer.concat(bodyChunks);

      // 构建上游请求 headers：跳过要覆盖的 + hop-by-hop headers
      const headers = {};
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
        headers[key] = value;
      }

      headers['host'] = API_HOST;
      // Anthropic API 要求 OAuth token 通过 x-api-key 传递，而非 Authorization: Bearer
      headers['x-api-key'] = token;
      headers['content-length'] = body.length;

      const options = {
        hostname: API_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: headers,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        const elapsed = Date.now() - startTime;
        console.log(
          `${logPrefix} -> ${proxyRes.statusCode} (${elapsed}ms)`,
        );

        // 收到 401 时触发后台刷新（不重放当前请求）
        if (proxyRes.statusCode === 401) {
          console.log('收到上游 401，触发后台刷新');
          tokenStore.triggerRefreshForActive();
        }

        // 原样转发状态码和 headers，然后 pipe 响应流（SSE 友好）
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error(`${logPrefix} 上游连接错误: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
        }
      });

      // 客户端中途断开时取消上游请求
      res.on('close', () => {
        if (!proxyReq.destroyed) proxyReq.destroy();
      });

      // 发送请求体并结束
      proxyReq.end(body);
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
