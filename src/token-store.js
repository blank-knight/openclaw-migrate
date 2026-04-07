const fs = require('fs');
const https = require('https');
const {
  CONFIG_PATH,
  CREDENTIALS_PATH,
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

  /**
   * 检查待导入的 token 是否已属于另一个账号。
   * @returns {string|null} 冲突的账号名，无冲突返回 null
   */
  findDuplicateToken(name, accessToken) {
    for (const [existingName, account] of Object.entries(this._config.accounts)) {
      if (existingName !== name && account.accessToken === accessToken) {
        return existingName;
      }
    }
    return null;
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

    // 记录旧的 refreshToken，用于后续同步判断
    const oldRefreshToken = account.refreshToken;

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
      // 刷新失败，尝试从 credentials 文件同步（Claude Code 可能已独立刷新）
      // 使用 force 模式跳过 subscriptionType 检查
      if (name === this._config.activeAccount && this.syncActiveFromCredentials({ force: true })) {
        console.log('OAuth 刷新失败，但从 credentials 文件同步成功');
        const synced = this._config.accounts[name];
        return {
          access_token: synced.accessToken,
          refresh_token: synced.refreshToken,
          expires_in: Math.max(0, Math.floor((synced.expiresAt - Date.now()) / 1000)),
        };
      }

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

    // 同步新 token 回 Claude 凭据文件
    this._syncToClaudeCredentials(oldRefreshToken, result);

    return result;
  }

  /**
   * 刷新后将新 token 同步回 ~/.claude/.credentials.json。
   * 仅当 Claude 凭据中的 refreshToken 与刷新前的旧 token 一致时才写回，
   * 避免覆盖用户在 Claude 中登录的其他账号。
   */
  _syncToClaudeCredentials(oldRefreshToken, refreshResult) {
    try {
      if (!fs.existsSync(CREDENTIALS_PATH)) return;

      const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const oauth = raw.claudeAiOauth;
      if (!oauth) return;

      // 只有 Claude 持有的 refreshToken 与旧值一致，才说明是同一份凭据
      if (oauth.refreshToken !== oldRefreshToken) return;

      // 写回新 token
      oauth.accessToken = refreshResult.access_token;
      oauth.refreshToken = refreshResult.refresh_token;
      oauth.expiresAt = Date.now() + refreshResult.expires_in * 1000;

      const tmp = CREDENTIALS_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
      fs.renameSync(tmp, CREDENTIALS_PATH);

      console.log('已同步新 token 到 Claude 凭据文件');
    } catch (err) {
      // 同步失败不影响主流程
      console.error(`同步 Claude 凭据失败: ${err.message}`);
    }
  }

  /**
   * 从 Claude 凭据文件反向同步 token 到 CCS。
   * 用于 CCS token 过期但 Claude 那边有更新的场景。
   */
  syncFromClaudeCredentials() {
    try {
      if (!fs.existsSync(CREDENTIALS_PATH)) return false;

      const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const oauth = raw.claudeAiOauth;
      if (!oauth || !oauth.refreshToken) return false;

      // 查找 CCS 中哪个账号与 Claude 凭据匹配
      // 匹配条件：importedFrom 是 Claude 凭据路径，且 CCS 的 token 已过期
      let synced = false;
      for (const [name, account] of Object.entries(this._config.accounts)) {
        const isFromClaude = account.importedFrom === CREDENTIALS_PATH;
        const isExpired = account.expiresAt && account.expiresAt < Date.now();

        if (isFromClaude && isExpired) {
          // Claude 的 token 比 CCS 的新且未过期
          if (oauth.expiresAt && oauth.expiresAt > Date.now()) {
            account.accessToken = oauth.accessToken;
            account.refreshToken = oauth.refreshToken;
            account.expiresAt = oauth.expiresAt;
            account.updatedAt = new Date().toISOString();
            console.log(`从 Claude 凭据反向同步账号 "${name}" 成功`);
            synced = true;
          }
        }
      }

      if (synced) this.save();
      return synced;
    } catch (err) {
      console.error(`反向同步 Claude 凭据失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 从 credentials 文件同步 active 账号的 token（启动时 / 刷新失败时调用）。
   * 当 CCS token 被 Claude Code 独立刷新导致失效时，从 credentials 文件恢复。
   *
   * @param {object} [options]
   * @param {boolean} [options.force] - 为 true 时跳过 subscriptionType 检查（401 恢复场景）
   */
  syncActiveFromCredentials(options = {}) {
    try {
      if (!fs.existsSync(CREDENTIALS_PATH)) return false;

      const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const oauth = raw.claudeAiOauth;
      if (!oauth || !oauth.accessToken || !oauth.refreshToken) return false;
      // credentials token 已过期则无用
      if (oauth.expiresAt && oauth.expiresAt < Date.now()) return false;

      const name = this._config.activeAccount;
      if (!name) return false;
      const account = this._config.accounts[name];
      if (!account) return false;

      // 只处理从 credentials 文件导入的账号
      if (account.importedFrom !== CREDENTIALS_PATH) return false;

      // token 相同，无需同步
      if (account.accessToken === oauth.accessToken) return false;

      // 安全检查：subscriptionType 匹配（避免跨账号污染）
      // 在 401 恢复场景 (force=true) 下跳过此检查，
      // 因为 credentials 中的 subscriptionType 可能被 Claude Code 刷新后改变
      if (
        !options.force &&
        oauth.subscriptionType &&
        account.subscriptionType &&
        oauth.subscriptionType !== account.subscriptionType
      ) {
        return false;
      }

      // 同步
      account.accessToken = oauth.accessToken;
      account.refreshToken = oauth.refreshToken;
      account.expiresAt = oauth.expiresAt;
      account.updatedAt = new Date().toISOString();
      this.save();

      console.log(`从 credentials 文件同步账号 "${name}" 成功`);
      return true;
    } catch (err) {
      console.error(`从 credentials 文件同步失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 将 active 账号的 token 写入 ~/.claude/.credentials.json。
   * 使 Claude Code 的登录状态检查通过。
   */
  writeActiveToCredentials() {
    try {
      const name = this._config.activeAccount;
      if (!name) return;
      const account = this._config.accounts[name];
      if (!account || !account.accessToken) return;

      let existing = {};
      if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
          existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        } catch {
          /* ignore */
        }
      }

      existing.claudeAiOauth = {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        scopes: account.scopes || [],
        subscriptionType: account.subscriptionType || 'unknown',
      };

      const tmp = CREDENTIALS_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf8');
      fs.renameSync(tmp, CREDENTIALS_PATH);
    } catch (err) {
      console.error(`写入 credentials 文件失败: ${err.message}`);
    }
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
              } catch (e) {
                console.error(`[REFRESH] ${host} 响应 200 但 JSON 解析失败: ${e.message}`);
                resolve(null);
              }
            } else {
              console.error(`[REFRESH] ${host} 返回 ${res.statusCode}: ${data.substring(0, 500)}`);
              resolve(null);
            }
          });
        },
      );
      req.on('error', (err) => {
        console.error(`[REFRESH] ${host} 网络错误: ${err.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        console.error(`[REFRESH] ${host} 请求超时`);
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
