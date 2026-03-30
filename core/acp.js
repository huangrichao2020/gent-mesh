/**
 * core/acp.js — ACP Server 模式
 *
 * 当设备有公网 IP 时，可启用 ACP Server 模式：
 * - 定义对外提供的能力（capabilities）
 * - 向根注册服务器注册
 * - 定时心跳保活
 * - 关闭时自动注销
 */

const http  = require('http');
const https = require('https');
const chalk = require('chalk');

// ── 官方根注册服务器 ──
const DEFAULT_REGISTRY = 'http://120.26.32.59:7701';
const HEARTBEAT_INTERVAL = 5 * 60 * 1000;  // 每 5 分钟心跳

class ACPClient {
  /**
   * @param {object} opts
   * @param {string}   opts.name          节点名
   * @param {string}   opts.description   描述
   * @param {string}   opts.endpoint      对外 WebSocket 地址（ws://公网IP:7700）
   * @param {array}    opts.capabilities  能力列表
   * @param {string[]} opts.tags          标签
   * @param {string}   opts.registry      根服务器地址（默认官方）
   */
  constructor(opts) {
    this.name         = opts.name;
    this.description  = opts.description || '';
    this.endpoint     = opts.endpoint;
    this.capabilities = opts.capabilities || [];
    this.tags         = opts.tags || [];
    this.registry     = opts.registry || DEFAULT_REGISTRY;
    this.token        = opts.token || 'acp-open-beta-2026';

    this._serverId    = null;
    this._hbTimer     = null;
  }

  // ── 注册 ──
  async register() {
    console.log(chalk.cyan(`\n  📡 向根注册服务器注册 ACP Server...`));
    console.log(chalk.gray(`     注册中心: ${this.registry}`));

    try {
      const body = JSON.stringify({
        name:         this.name,
        description:  this.description,
        endpoint:     this.endpoint,
        capabilities: this.capabilities,
        tags:         this.tags,
      });

      const res = await this._post('/register', body);

      if (!res.ok) throw new Error(res.error || 'register failed');

      this._serverId = res.id;
      console.log(chalk.green(`  ✅ ACP 注册成功`));
      console.log(chalk.gray(`     Server ID: ${this._serverId}`));
      console.log(chalk.gray(`     能力: ${this.capabilities.map(c => c.id).join(', ')}`));

      // 启动心跳
      this._startHeartbeat();

      // 进程退出时自动注销
      process.on('SIGINT',  () => this.unregister().then(() => process.exit(0)));
      process.on('SIGTERM', () => this.unregister().then(() => process.exit(0)));

      return true;
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  ACP 注册失败: ${err.message}`));
      console.log(chalk.gray(`     将在 60s 后重试`));
      setTimeout(() => this.register(), 60_000);
      return false;
    }
  }

  // ── 心跳 ──
  _startHeartbeat() {
    this._hbTimer = setInterval(async () => {
      try {
        await this._post('/heartbeat', JSON.stringify({ id: this._serverId }));
      } catch {
        console.log(chalk.yellow('  ⚠️  ACP 心跳失败，将重新注册'));
        clearInterval(this._hbTimer);
        setTimeout(() => this.register(), 5000);
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ── 注销 ──
  async unregister() {
    clearInterval(this._hbTimer);
    if (!this._serverId) return;
    try {
      await this._delete('/unregister', JSON.stringify({ id: this._serverId }));
      console.log(chalk.yellow(`\n  📡 ACP Server 已注销`));
    } catch { /* 忽略注销错误 */ }
  }

  // ── HTTP 工具 ──
  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url   = new URL(this.registry + path);
      const isHttps = url.protocol === 'https:';
      const lib   = isHttps ? https : http;

      const opts = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname,
        method,
        headers:  {
          'Content-Type':      'application/json',
          'Content-Length':    Buffer.byteLength(body || ''),
          'X-Registry-Token':  this.token,
        },
      };

      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false, error: data }); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });

      if (body) req.write(body);
      req.end();
    });
  }

  _post(path, body)   { return this._request('POST',   path, body); }
  _delete(path, body) { return this._request('DELETE', path, body); }
}

/**
 * 搜索 ACP Server（供调用方使用）
 *
 * @param {object} opts
 * @param {string} opts.capability  能力 id
 * @param {string} opts.q          全文搜索
 * @param {string} opts.tag        标签过滤
 * @param {string} opts.registry   根服务器（默认官方）
 */
async function searchACP(opts = {}) {
  const registry = opts.registry || DEFAULT_REGISTRY;
  const params   = new URLSearchParams();
  if (opts.capability) params.set('capability', opts.capability);
  if (opts.q)          params.set('q',          opts.q);
  if (opts.tag)        params.set('tag',         opts.tag);
  if (opts.limit)      params.set('limit',       opts.limit);

  return new Promise((resolve, reject) => {
    const url  = new URL(`${registry}/search?${params}`);
    const lib  = url.protocol === 'https:' ? https : http;

    lib.get(url.toString(), (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('parse error')); }
      });
    }).on('error', reject);
  });
}

module.exports = { ACPClient, searchACP, DEFAULT_REGISTRY };
