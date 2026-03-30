/**
 * core/spoke.js — Spoke 节点客户端
 *
 * 主动连接 Hub，维持心跳，处理任务分发，流式输出结果。
 * 内置故障转移：Hub 挂了先按预设备用列表切换，全挂了启动在线率选举。
 */

const WebSocket  = require('ws');
const chalk      = require('chalk');
const { MSG, createMsg, parseMsg } = require('./message');
const { detectHubNetwork } = require('./detect');
const { ElectionManager, UptimeTracker } = require('./election');

const HEARTBEAT_INTERVAL = 20_000;
const HUB_TIMEOUT_MS     = 60_000;   // 60s 无心跳响应视为 Hub 挂
const RECONNECT_BASE     = 3_000;
const RECONNECT_MAX      = 30_000;

class Spoke {
  constructor(cfg) {
    this.cfg        = cfg;
    this.name       = cfg.name;
    this.hubUrl     = cfg.hubUrl;
    this.token      = cfg.hubToken;
    this.agentName  = cfg.agent || 'unknown';

    this.ws          = null;
    this.connected   = false;
    this.reconnectMs = RECONNECT_BASE;
    this._hbTimer    = null;
    this._reconnTimer = null;
    this._hubTimeoutTimer = null;
    this._lastHubPong = Date.now();

    // 在线率追踪
    this._uptime = new UptimeTracker();

    // 选举管理器
    this._election = new ElectionManager({
      myName:      this.name,
      backupHubs:  cfg.backupHubs || [],
      send:        (msg) => this._send(msg),
      connectHub:  (name) => this._switchHub(name),
      uptimeTracker: this._uptime,
    });

    this._election.on('new-hub', (name) => this._switchHub(name));
    this._election.on('become-hub', () => this._becomeHub());
    this._election.on('hub-restored', () => {
      // 原 Hub 恢复，重新连接原地址
      this._connect();
    });

    this._handlers = new Map();
    this._setupDefaultHandlers();
  }

  // ── 连接 ──
  async start() {
    const netType = await detectHubNetwork(this.hubUrl);
    console.log(chalk.cyan(`  网络类型: ${netType === 'lan' ? '局域网' : '公网'}`));

    if (netType === 'wan') {
      console.log(chalk.yellow(
        '  ⚠️  公网模式：请确认 Hub 的 7700/7701 端口对外开放\n' +
        '     或通过反向 SSH 隧道连接：\n' +
        '     ssh -R 7700:localhost:7700 -R 7701:localhost:7701 root@hub-ip -N'
      ));
    }

    this._connect();
  }

  _connect() {
    console.log(chalk.gray(`  → 连接 Hub: ${this.hubUrl} ...`));
    this.ws = new WebSocket(this.hubUrl);
    this.ws.on('open',    ()    => this._onOpen());
    this.ws.on('message', (raw) => this._onMessage(raw.toString()));
    this.ws.on('close',   ()    => this._onClose());
    this.ws.on('error',   (err) => {
      console.error(chalk.red(`  连接错误: ${err.message}`));
    });
  }

  _onOpen() {
    this.connected   = true;
    this.reconnectMs = RECONNECT_BASE;
    this._uptime.onConnected();
    this._lastHubPong = Date.now();

    // 注册，携带在线率
    this._send(createMsg(MSG.REGISTER, this.name, 'hub', {
      name:       this.name,
      agent:      this.agentName,
      token:      this.token,
      uptimeRate: this._uptime.getRate(),
    }));

    // 心跳
    this._hbTimer = setInterval(() => {
      this._send(createMsg(MSG.HEARTBEAT, this.name, 'hub'));
    }, HEARTBEAT_INTERVAL);

    // Hub 超时检测
    this._hubTimeoutTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastHubPong;
      if (elapsed > HUB_TIMEOUT_MS) {
        console.log(chalk.red(`  ⚠️  Hub 心跳超时 (${Math.round(elapsed / 1000)}s)，启动故障转移`));
        clearInterval(this._hubTimeoutTimer);
        clearInterval(this._hbTimer);
        this._election.onHubLost();
      }
    }, 10_000);  // 每 10s 检查一次

    console.log(chalk.green(`  ✅ 已连接 Hub（节点名: ${this.name}）`));
    if (this.cfg.backupHubs?.length) {
      console.log(chalk.gray(`  🔄 备用 Hub: ${this.cfg.backupHubs.join(' → ')}`));
    }
  }

  _onMessage(raw) {
    const msg = parseMsg(raw);
    if (!msg) return;

    // 收到 Hub 任何消息，都刷新最后在线时间
    if (msg.from === 'hub' || msg.type === MSG.HEARTBEAT_ACK) {
      this._lastHubPong = Date.now();
    }

    // 选举相关消息
    if (msg.type === MSG.ELECTION_CALL) {
      this._uptime.getRate && this._send(createMsg(MSG.ELECTION_CALL, this.name, '*', {
        uptimeRate: this._uptime.getRate(),
      }));
      this._election.onElectionResponse(msg);
      return;
    }
    if (msg.type === MSG.ELECTION_WIN) {
      this._election.onElectionWin(msg);
      return;
    }

    // Ping 响应（用于备用 Hub 探活）
    if (msg.type === MSG.QUERY && msg.payload?.ping) {
      this._send(createMsg(MSG.REPORT, this.name, msg.from, {
        pong: true,
        uptimeRate: this._uptime.getRate(),
      }));
      return;
    }
    if (msg.type === MSG.REPORT && msg.payload?.pong) {
      this._election.receivePong(msg.from);
      return;
    }

    const handler = this._handlers.get(msg.type);
    if (handler) handler(msg);
    else this.emit('message', msg);
  }

  _onClose() {
    this.connected = false;
    this._uptime.onDisconnected();
    clearInterval(this._hbTimer);
    clearInterval(this._hubTimeoutTimer);

    console.log(chalk.yellow(`  ↓ 与 Hub 断开，${this.reconnectMs / 1000}s 后重连...`));

    this._reconnTimer = setTimeout(() => this._connect(), this.reconnectMs);
    this.reconnectMs  = Math.min(this.reconnectMs * 2, RECONNECT_MAX);
  }

  // ── 故障转移：切换到新 Hub ──
  _switchHub(newHubName) {
    console.log(chalk.cyan(`  🔄 切换到新 Hub: ${newHubName}`));
    // 这里需要知道新 Hub 的 URL，约定同端口，只换 host
    // 实际使用时 nodes_list 中包含了每个节点的 IP
    const newUrl = this._resolveHubUrl(newHubName);
    if (!newUrl) {
      console.log(chalk.red(`  无法解析 ${newHubName} 的地址，等待重连`));
      return;
    }
    this.hubUrl = newUrl;
    clearTimeout(this._reconnTimer);
    if (this.ws) this.ws.close();
    setTimeout(() => this._connect(), 500);
  }

  // ── 故障转移：我自己升级为 Hub ──
  _becomeHub() {
    console.log(chalk.bold.green(`\n  🏆 ${this.name} 升级为临时 Hub\n`));
    this.emit('become-hub', { name: this.name });
    // 上层（mesh.js）监听此事件后，启动 Hub 服务并切换角色
  }

  // 解析节点名 → WS URL（从 nodes_list 缓存中查）
  _resolveHubUrl(nodeName) {
    const node = this._knownNodes?.find(n => n.name === nodeName);
    if (!node?.ip) return null;
    const port = new URL(this.hubUrl).port || 7700;
    return `ws://${node.ip}:${port}`;
  }

  _setupDefaultHandlers() {
    this.on(MSG.REGISTER_ACK, (msg) => {
      console.log(chalk.green(`  📋 注册确认 → 节点名: ${msg.payload.nodeName}`));
    });

    this.on(MSG.HEARTBEAT_ACK, () => {
      this._lastHubPong = Date.now();
    });

    this.on(MSG.NODES_LIST, (msg) => {
      // 缓存节点列表（用于故障转移时解析地址）
      this._knownNodes = msg.payload || [];
      const names = this._knownNodes.map(n => n.name).join(', ');
      if (names) console.log(chalk.gray(`  🌐 在线节点: ${names}`));
    });

    this.on(MSG.ERROR, (msg) => {
      console.error(chalk.red(`  Hub 错误: ${msg.payload}`));
    });

    this.on(MSG.INTERRUPT, () => {
      console.log(chalk.yellow('  ⚡ 收到中断指令'));
      this.emit('interrupt');
    });
  }

  // ── 对外 API ──
  send(to, payload, type = MSG.QUERY, opts = {}) {
    this._send(createMsg(type, this.name, to, payload, opts));
  }

  sendChunk(to, chunk, sessionId) {
    this._send(createMsg(MSG.STREAM_CHUNK, this.name, to, chunk, {
      session: sessionId, done: false,
    }));
  }

  sendDone(to, sessionId) {
    this._send(createMsg(MSG.STREAM_DONE, this.name, to, null, {
      session: sessionId, done: true,
    }));
  }

  /** 获取本节点在线率（0~1） */
  getUptimeRate() {
    return this._uptime.getRate();
  }

  on(type, handler) {
    this._handlers.set(type, handler);
    return this;
  }

  emit(type, data) {
    const h = this._handlers.get(type);
    if (h) h(data);
  }

  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    clearInterval(this._hbTimer);
    clearInterval(this._hubTimeoutTimer);
    clearTimeout(this._reconnTimer);
    this._uptime.onDisconnected();
    if (this.ws) {
      this._send(createMsg(MSG.DISCONNECT, this.name, 'hub'));
      this.ws.close();
    }
  }
}

module.exports = { Spoke };
