const fs = require('fs');
const https = require('https');
const {
  CONFIG_PATH,
  DEFAULT_CLIENT_ID,
  PLATFORM_HOST,
  FALLBACK_HOST,
  ensureCcsDir,
} = require('./utils');

class TokenStore {
  constructor() {
    this._config = null;
    this._refreshLocks = new Map(); // accountName -> Promise
    this._refreshTimer = null;
    this.load();
  }

  // ── 配置读写 ─────────────────────────────────────────

  load() {
    ensureCcsDir();
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        this._config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        this._configMtime = fs.statSync(CONFIG_PATH).mtimeMs;
      } catch {
        this._config = this._defaultConfig();
        this._configMtime = 0;
      }
    } else {
      this._config = this._defaultConfig();
      this._configMtime = 0;
    }
  }

  /** 如果配置文件在外部被修改过（如用户本地执行了 ccs import），则重新加载 */
  reloadIfChanged() {
    try {
      const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
      if (mtime !== this._configMtime) {
        this.load();
      }
    } catch {
      /* ignore */
    }
  }

  save() {
    ensureCcsDir();
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._config, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    this._configMtime = fs.statSync(CONFIG_PATH).mtimeMs;
  }

  _defaultConfig() {
    return {
      version: 1,
      activeAccount: null,
      clientId: null,
      ports: { proxy: 9876, control: 9877 },
      accounts: {},
    };
  }

  get config() {
    return this._config;
  }

  get clientId() {
    return this._config.clientId || DEFAULT_CLIENT_ID;
  }

  set clientId(id) {
    this._config.clientId = id;
    this.save();
  }

  // ── 账号操作 ─────────────────────────────────────────

  getActiveAccountName() {
    return this._config.activeAccount;
  }

  getActiveAccount() {
    const name = this._config.activeAccount;
    if (!name || !this._config.accounts[name]) return null;
    return this._config.accounts[name];
  }

  /**
   * 获取当前激活账号的 accessToken。
   * 如果 token 即将过期（< 60 s），会先自动刷新。
   */
  async getActiveToken() {
    this.reloadIfChanged();
    const name = this._config.activeAccount;
    if (!name) throw new Error('没有激活的账号，请先执行 ccs switch <account>');

    const account = this._config.accounts[name];
    if (!account) throw new Error(`账号 "${name}" 不存在`);

    // 距过期 < 60 s 就先刷新
    if (account.expiresAt && account.expiresAt - Date.now() < 60000) {
      await this.refreshAccount(name);
    }

    return this._config.accounts[name].accessToken;
  }

  importAccount(name, credentials) {
    this._config.accounts[name] = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      subscriptionType: credentials.subscriptionType || 'unknown',
      scopes: credentials.scopes || [],
      importedFrom: credentials.importedFrom || 'manual',
      updatedAt: new Date().toISOString(),
    };

    // 第一个导入的账号自动激活
    if (!this._config.activeAccount) {
      this._config.activeAccount = name;
    }

    this.save();
    return this._config.accounts[name];
  }

  switchAccount(name) {
    if (!this._config.accounts[name]) {
      const existing = Object.keys(this._config.accounts).join(', ') || '无';
      throw new Error(`账号 "${name}" 不存在。已有账号: ${existing}`);
    }
    this._config.activeAccount = name;
    this.save();
  }

  getAccounts() {
    const result = {};
    for (const [name, account] of Object.entries(this._config.accounts)) {
      result[name] = {
        subscriptionType: account.subscriptionType,
        isActive: name === this._config.activeAccount,
        expiresAt: account.expiresAt,
        tokenPrefix: account.accessToken
          ? account.accessToken.substring(0, 16)
          : 'N/A',
      };
    }
    return result;
  }

  // ── Token 刷新 ───────────────────────────────────────

  /**
   * 刷新指定账号的 token。
   * 每个账号同一时刻只允许一个刷新流程，其余并发调用共享同一个 Promise。
   */
  async refreshAccount(name) {
    this.reloadIfChanged();
    if (this._refreshLocks.has(name)) {
      return this._refreshLocks.get(name);
    }

    const promise = this._doRefresh(name);
    this._refreshLocks.set(name, promise);
    try {
      return await promise;
    } finally {
      this._refreshLocks.delete(name);
    }
  }

  async _doRefresh(name) {
    const account = this._config.accounts[name];
    if (!account) throw new Error(`账号 "${name}" 不存在`);
    if (!account.refreshToken) throw new Error(`账号 "${name}" 没有 refreshToken`);

    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: this.clientId,
    });

    // 先尝试主端点 (platform.claude.com - 从 claude.exe 提取的真实端点)
    let result = await this._postRefresh(PLATFORM_HOST, body);
    // 失败则 fallback
    if (!result) {
      result = await this._postRefresh(FALLBACK_HOST, body);
    }

    if (!result) {
      throw new Error(
        `账号 "${name}" token 刷新失败，可能需要重新导入 (ccs import ${name})`,
      );
    }

    // 立即持久化
    account.accessToken = result.access_token;
    account.refreshToken = result.refresh_token;
    account.expiresAt = Date.now() + result.expires_in * 1000;
    account.updatedAt = new Date().toISOString();
    this.save();

    return result;
  }

  _postRefresh(host, body) {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: host,
          port: 443,
          path: '/v1/oauth/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  // ── 后台定时刷新 ─────────────────────────────────────

  startBackgroundRefresh() {
    // 每 30 分钟扫描一次
    this._refreshTimer = setInterval(() => {
      this._backgroundRefreshAll();
    }, 30 * 60 * 1000);

    // 启动后立即做一次
    this._backgroundRefreshAll();
  }

  stopBackgroundRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  async _backgroundRefreshAll() {
    const ONE_HOUR = 60 * 60 * 1000;
    for (const name of Object.keys(this._config.accounts)) {
      const account = this._config.accounts[name];
      if (account.expiresAt && account.expiresAt - Date.now() < ONE_HOUR) {
        try {
          await this.refreshAccount(name);
          console.log(`后台刷新账号 "${name}" 成功`);
        } catch (err) {
          console.error(`后台刷新账号 "${name}" 失败: ${err.message}`);
        }
      }
    }
  }

  /** 收到上游 401 时调用，触发当前激活账号的后台刷新 */
  triggerRefreshForActive() {
    const name = this._config.activeAccount;
    if (name) {
      this.refreshAccount(name).catch((err) => {
        console.error(`401 触发刷新失败: ${err.message}`);
      });
    }
  }
}

module.exports = TokenStore;
