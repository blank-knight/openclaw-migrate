const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CCS_DIR = path.join(HOME, '.ccs');
const CONFIG_PATH = path.join(CCS_DIR, 'config.json');
const PID_PATH = path.join(CCS_DIR, 'daemon.pid');
const KEEPALIVE_PID_PATH = path.join(CCS_DIR, 'keepalive.pid');
const LOG_PATH = path.join(CCS_DIR, 'daemon.log');
const KEEPALIVE_LOG_PATH = path.join(CCS_DIR, 'keepalive.log');
const CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');

const PROXY_PORT = 9876;
const CONTROL_PORT = 9877;
const API_HOST = 'api.anthropic.com';
const PLATFORM_HOST = 'platform.claude.com';
const FALLBACK_HOST = 'console.anthropic.com';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function ensureCcsDir() {
  if (!fs.existsSync(CCS_DIR)) {
    fs.mkdirSync(CCS_DIR, { recursive: true });
  }
}

function findClaudeExe() {
  try {
    const result = execSync('where claude', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return result.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return 'unknown';
  const d = new Date(expiresAt);
  const now = Date.now();
  const diff = expiresAt - now;

  if (diff <= 0) return `已过期 (${d.toLocaleString()})`;

  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h${mins}m 后过期 (${d.toLocaleString()})`;
  return `${mins}m 后过期 (${d.toLocaleString()})`;
}

function maskToken(token) {
  if (!token) return 'N/A';
  return token.substring(0, 16) + '...';
}

function callControlApi(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1',
      port: CONTROL_PORT,
      path: urlPath,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };
    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Control API timeout'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = {
  HOME,
  CCS_DIR,
  CONFIG_PATH,
  PID_PATH,
  KEEPALIVE_PID_PATH,
  LOG_PATH,
  KEEPALIVE_LOG_PATH,
  CREDENTIALS_PATH,
  PROXY_PORT,
  CONTROL_PORT,
  API_HOST,
  PLATFORM_HOST,
  FALLBACK_HOST,
  DEFAULT_CLIENT_ID,
  ensureCcsDir,
  findClaudeExe,
  formatExpiry,
  maskToken,
  callControlApi,
};
