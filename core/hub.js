/**
 * core/hub.js — WebSocket Hub（中枢服务器）
 *
 * 监听 7700（WebSocket）和 7701（HTTP API），
 * 维护所有 Spoke 连接，转发消息。
 */

const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');
const chalk     = require('chalk');
const { MSG, createMsg, parseMsg } = require('./message');
const { randomUUID } = require('crypto');

class Hub {
  constructor(cfg) {
    this.cfg      = cfg;
    this.name     = cfg.name || 'hub';
    this.wsPort   = cfg.wsPort  || 7700;
    this.apiPort  = cfg.apiPort || 7701;
    this.token    = cfg.hubToken || this._genToken();

    // nodeName → { ws, name, agent, connectedAt, lastSeen }
    this.nodes    = new Map();
  }

  _genToken() {
    return 'hub_' + randomUUID().replace(/-/g, '').slice(0, 20);
  }

  // ── 启动 ──
  async start() {
    await this._startWS();
    await this._startAPI();

    console.log(chalk.bold.green('\n✅  Hub 启动成功\n'));
    console.log(chalk.cyan('  WebSocket:') + ` ws://0.0.0.0:${this.wsPort}`);
    console.log(chalk.cyan('  API管理:  ') + ` http://0.0.0.0:${this.apiPort}`);
    console.log(chalk.cyan('  Token:    ') + ` ${this.token}`);
    console.log(chalk.gray('\n  Spoke 节点使用以下命令连接：'));
    console.log(chalk.white(`  mesh init  →  填写 Hub 地址和 Token\n`));
  }

  // ── WebSocket 服务 ──
  _startWS() {
    return new Promise((resolve) => {
      this.wss = new WebSocket.Server({ port: this.wsPort }, resolve);
      this.wss.on('connection', (ws, req) => this._onConnect(ws, req));
      this.wss.on('error', (err) => {
        console.error(chalk.red(`WebSocket 错误: ${err.message}`));
      });
    });
  }

  _onConnect(ws, req) {
    const remoteIP = req.socket.remoteAddress;
    let nodeName = null;

    ws.on('message', (raw) => {
      const msg = parseMsg(raw.toString());
      if (!msg) return;

      // 第一条消息必须是 REGISTER
      if (!nodeName && msg.type !== MSG.REGISTER) {
        ws.send(JSON.stringify(createMsg(MSG.ERROR, this.name, 'unknown',
          'First message must be register')));
        ws.close();
        return;
      }

      switch (msg.type) {
        case MSG.REGISTER:    nodeName = this._onRegister(ws, msg, remoteIP); break;
        case MSG.HEARTBEAT:   this._onHeartbeat(ws, msg); break;
        case MSG.STREAM_CHUNK:
        case MSG.STREAM_DONE:
        case MSG.REPORT:
        case MSG.QUERY:       this._relay(msg); break;
        case MSG.DISCONNECT:  this._onDisconnect(nodeName); break;
        default:              this._relay(msg);
      }
    });

    ws.on('close', () => {
      if (nodeName) this._onDisconnect(nodeName);
    });

    ws.on('error', () => {
      if (nodeName) this._onDisconnect(nodeName);
    });
  }

  _onRegister(ws, msg, remoteIP) {
    const { name, agent, token } = msg.payload || {};

    if (token !== this.token) {
      ws.send(JSON.stringify(createMsg(MSG.ERROR, this.name, name || 'unknown',
        'Invalid token')));
      ws.close();
      return null;
    }

    const nodeName = name || `spoke_${randomUUID().slice(0, 6)}`;
    this.nodes.set(nodeName, {
      ws,
      name:        nodeName,
      agent:       agent || 'unknown',
      ip:          remoteIP,
      connectedAt: Date.now(),
      lastSeen:    Date.now(),
    });

    // 确认注册
    ws.send(JSON.stringify(createMsg(MSG.REGISTER_ACK, this.name, nodeName, {
      hubName:   this.name,
      nodeName,
      timestamp: Date.now(),
    })));

    // 广播节点列表更新
    this._broadcastNodesList();

    console.log(chalk.green(`  ↑ 节点上线: ${nodeName} (${agent}) [${remoteIP}]`));
    return nodeName;
  }

  _onHeartbeat(ws, msg) {
    const node = this.nodes.get(msg.from);
    if (node) node.lastSeen = Date.now();
    ws.send(JSON.stringify(createMsg(MSG.HEARTBEAT_ACK, this.name, msg.from)));
  }

  _onDisconnect(nodeName) {
    if (!nodeName || !this.nodes.has(nodeName)) return;
    this.nodes.delete(nodeName);
    this._broadcastNodesList();
    console.log(chalk.yellow(`  ↓ 节点下线: ${nodeName}`));
  }

  // 转发消息给目标节点
  _relay(msg) {
    if (msg.to === '*') {
      // 广播给所有节点
      for (const [name, node] of this.nodes) {
        if (name !== msg.from) this._send(node.ws, msg);
      }
      return;
    }
    const target = this.nodes.get(msg.to);
    if (target) {
      this._send(target.ws, msg);
    } else {
      // 目标不在线，回报发送方
      const sender = this.nodes.get(msg.from);
      if (sender) {
        this._send(sender.ws, createMsg(MSG.ERROR, this.name, msg.from,
          `Target node '${msg.to}' is not online`));
      }
    }
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  _broadcastNodesList() {
    const list = Array.from(this.nodes.values()).map(n => ({
      name:        n.name,
      agent:       n.agent,
      ip:          n.ip,
      connectedAt: n.connectedAt,
    }));
    const msg = createMsg(MSG.NODES_LIST, this.name, '*', list);
    for (const node of this.nodes.values()) {
      this._send(node.ws, msg);
    }
  }

  // ── HTTP API ──
  _startAPI() {
    return new Promise((resolve) => {
      const app = express();
      app.use(express.json());

      // 健康检查
      app.get('/health', (_, res) => res.json({ status: 'ok', hub: this.name }));

      // 在线节点列表
      app.get('/nodes', (req, res) => {
        if (req.headers['x-token'] !== this.token) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const list = Array.from(this.nodes.values()).map(n => ({
          name: n.name, agent: n.agent, ip: n.ip, connectedAt: n.connectedAt,
          lastSeen: n.lastSeen,
        }));
        res.json({ nodes: list, count: list.length });
      });

      // 向指定节点发消息（供人类手动触发）
      app.post('/send', (req, res) => {
        if (req.headers['x-token'] !== this.token) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const { to, payload, type } = req.body;
        const msg = createMsg(type || MSG.TASK_ASSIGN, this.name, to, payload);
        this._relay(msg);
        res.json({ ok: true, msgId: msg.id });
      });

      const server = http.createServer(app);
      server.listen(this.apiPort, () => resolve());
    });
  }
}

module.exports = { Hub };
