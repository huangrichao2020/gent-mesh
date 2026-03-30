/**
 * core/spoke.js — Spoke 节点客户端
 *
 * 主动连接 Hub，维持心跳，处理任务分发，
 * 流式输出结果。自动检测局域网/公网并给出建议。
 */

const WebSocket  = require('ws');
const chalk      = require('chalk');
const { MSG, createMsg, parseMsg } = require('./message');
const { detectHubNetwork } = require('./detect');

const HEARTBEAT_INTERVAL = 20_000;   // 20s 心跳
const RECONNECT_BASE     = 3_000;    // 初始重连间隔
const RECONNECT_MAX      = 30_000;   // 最大重连间隔

class Spoke {
  constructor(cfg) {
    this.cfg          = cfg;
    this.name         = cfg.name;
    this.hubUrl       = cfg.hubUrl;
    this.token        = cfg.hubToken;
    this.agentName    = cfg.agent || 'unknown';

    this.ws           = null;
    this.connected    = false;
    this.reconnectMs  = RECONNECT_BASE;
    this._hbTimer     = null;
    this._reconnTimer = null;

    // 消息处理器 map：type → handler
    this._handlers    = new Map();
    this._setupDefaultHandlers();
  }

  // ── 连接 ──
  async start() {
    // 检测网络类型
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

    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (raw) => this._onMessage(raw.toString()));
    this.ws.on('close', () => this._onClose());
    this.ws.on('error', (err) => {
      console.error(chalk.red(`  连接错误: ${err.message}`));
    });
  }

  _onOpen() {
    this.connected   = true;
    this.reconnectMs = RECONNECT_BASE;

    // 注册自己
    this._send(createMsg(MSG.REGISTER, this.name, 'hub', {
      name:  this.name,
      agent: this.agentName,
      token: this.token,
    }));

    // 启动心跳
    this._hbTimer = setInterval(() => {
      this._send(createMsg(MSG.HEARTBEAT, this.name, 'hub'));
    }, HEARTBEAT_INTERVAL);

    console.log(chalk.green(`  ✅ 已连接 Hub（节点名: ${this.name}）`));
  }

  _onMessage(raw) {
    const msg = parseMsg(raw);
    if (!msg) return;

    const handler = this._handlers.get(msg.type);
    if (handler) handler(msg);
    else this.emit('message', msg); // 透传给上层
  }

  _onClose() {
    this.connected = false;
    clearInterval(this._hbTimer);

    console.log(chalk.yellow(`  ↓ 与 Hub 断开连接，${this.reconnectMs / 1000}s 后重连...`));

    this._reconnTimer = setTimeout(() => {
      this._connect();
    }, this.reconnectMs);

    // 指数退避，最大 30s
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX);
  }

  _setupDefaultHandlers() {
    this.on(MSG.REGISTER_ACK, (msg) => {
      console.log(chalk.green(`  📋 注册确认 → 节点名: ${msg.payload.nodeName}`));
    });

    this.on(MSG.HEARTBEAT_ACK, () => {
      // 静默处理心跳响应
    });

    this.on(MSG.NODES_LIST, (msg) => {
      const nodes = msg.payload || [];
      if (nodes.length > 0) {
        console.log(chalk.gray(`  🌐 当前在线节点: ${nodes.map(n => n.name).join(', ')}`));
      }
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

  /**
   * 向指定节点或 Hub 发送消息
   */
  send(to, payload, type = MSG.QUERY, opts = {}) {
    this._send(createMsg(type, this.name, to, payload, opts));
  }

  /**
   * 流式发送（Agent 边生成边转发）
   * 调用方负责循环调用 sendChunk，最后调用 sendDone
   */
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

  /**
   * 注册消息类型处理器
   */
  on(type, handler) {
    this._handlers.set(type, handler);
    return this;
  }

  emit(type, data) {
    // 简单事件系统，上层可覆盖
    const h = this._handlers.get('*');
    if (h) h({ type, data });
  }

  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    clearInterval(this._hbTimer);
    clearTimeout(this._reconnTimer);
    if (this.ws) {
      this._send(createMsg(MSG.DISCONNECT, this.name, 'hub'));
      this.ws.close();
    }
  }
}

module.exports = { Spoke };
