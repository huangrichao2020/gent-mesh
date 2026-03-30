/**
 * core/election.js — Hub 故障转移 + 选举
 *
 * 策略：
 *   1. Hub 心跳超时，先按主人预设的 backupHubs 顺序尝试
 *   2. 预设备用全挂了，启动在线率选举，在线率最高的节点当选
 *
 * 在线率 = 累计在线时长 / 累计注册时长（各节点自己维护，不依赖 Hub）
 */

const EventEmitter = require('events');
const { MSG, createMsg } = require('./message');

const HUB_TIMEOUT_MS    = 60_000;   // 60s 无心跳视为 Hub 挂了
const ELECTION_WAIT_MS  = 5_000;    // 等待 5s 收集所有节点的在线率
const CAMPAIGN_RAND_MS  = 3_000;    // 随机延迟 0-3s 避免同时抢

class ElectionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.myName        本节点名
   * @param {string[]} opts.backupHubs    主人预设的备用 Hub 列表（按优先级）
   * @param {Function} opts.send          发送消息的函数 send(msg)
   * @param {Function} opts.connectHub    切换连接目标 connectHub(url)
   * @param {object}   opts.uptimeTracker 本节点在线率追踪器实例
   */
  constructor(opts) {
    super();
    this.myName        = opts.myName;
    this.backupHubs    = opts.backupHubs || [];
    this.send          = opts.send;
    this.connectHub    = opts.connectHub;
    this.uptimeTracker = opts.uptimeTracker;

    this._hubLostAt    = null;
    this._electing     = false;
    this._candidates   = new Map();  // nodeName → uptimeRate
    this._electionTimer = null;
  }

  /**
   * 通知 Hub 心跳丢失，开始故障转移流程
   */
  onHubLost() {
    if (this._electing) return;
    this._hubLostAt = Date.now();
    this._electing  = true;
    this._candidates.clear();

    console.log('[election] Hub 心跳超时，开始故障转移...');
    this._tryBackups(0);
  }

  /**
   * Step 1：按顺序尝试预设备用 Hub
   */
  async _tryBackups(idx) {
    if (idx >= this.backupHubs.length) {
      console.log('[election] 所有预设备用 Hub 均不可达，启动在线率选举');
      this._startElection();
      return;
    }

    const candidate = this.backupHubs[idx];
    console.log(`[election] 尝试预设备用 Hub [${idx + 1}/${this.backupHubs.length}]: ${candidate}`);

    const reachable = await this._pingNode(candidate);
    if (reachable) {
      console.log(`[election] ✅ 备用 Hub ${candidate} 响应，切换连接`);
      this._electing = false;
      this.emit('new-hub', candidate);
    } else {
      console.log(`[election] ❌ ${candidate} 不可达，尝试下一个`);
      this._tryBackups(idx + 1);
    }
  }

  /**
   * Step 2：广播选举邀请，收集各节点在线率
   */
  _startElection() {
    // 先广播自己的在线率
    const myRate = this.uptimeTracker.getRate();
    this._candidates.set(this.myName, myRate);

    this.send(createMsg(MSG.ELECTION_CALL, this.myName, '*', {
      uptimeRate: myRate,
      startedAt:  this._hubLostAt,
    }));

    console.log(`[election] 已广播选举邀请，我的在线率: ${(myRate * 100).toFixed(1)}%`);
    console.log(`[election] 等待 ${ELECTION_WAIT_MS / 1000}s 收集候选节点...`);

    this._electionTimer = setTimeout(() => {
      this._decide();
    }, ELECTION_WAIT_MS);
  }

  /**
   * 收到其他节点的选举响应
   */
  onElectionResponse(msg) {
    if (!this._electing) return;
    const { uptimeRate } = msg.payload || {};
    if (typeof uptimeRate === 'number') {
      this._candidates.set(msg.from, uptimeRate);
      console.log(`[election] 收到 ${msg.from} 在线率: ${(uptimeRate * 100).toFixed(1)}%`);
    }
  }

  /**
   * Step 3：选出在线率最高的节点，加随机延迟避免同时宣布
   */
  _decide() {
    if (!this._electing) return;

    // 找出在线率最高的节点
    let winner = this.myName;
    let maxRate = this._candidates.get(this.myName) || 0;

    for (const [name, rate] of this._candidates) {
      if (rate > maxRate) {
        winner = name;
        maxRate = rate;
      }
    }

    console.log(`[election] 选举结果: ${winner} 在线率 ${(maxRate * 100).toFixed(1)}%`);

    if (winner === this.myName) {
      // 我赢了，加随机延迟后宣布
      const delay = Math.random() * CAMPAIGN_RAND_MS;
      console.log(`[election] 我是赢家，${(delay / 1000).toFixed(1)}s 后宣布`);
      setTimeout(() => this._announceVictory(maxRate), delay);
    } else {
      console.log(`[election] ${winner} 当选，等待其广播`);
      // 如果 5s 内没收到胜者广播，自己再尝试
      this._fallbackTimer = setTimeout(() => {
        if (this._electing) {
          console.log('[election] 胜者未响应，我来接管');
          this._announceVictory(this._candidates.get(this.myName) || 0);
        }
      }, 5000);
    }
  }

  /**
   * 宣布自己当选为临时 Hub
   */
  _announceVictory(rate) {
    if (!this._electing) return;
    this._electing = false;

    this.send(createMsg(MSG.ELECTION_WIN, this.myName, '*', {
      newHub:    this.myName,
      uptimeRate: rate,
      electedAt: Date.now(),
    }));

    console.log(`[election] 🏆 我 (${this.myName}) 成为临时 Hub`);
    this.emit('become-hub');
  }

  /**
   * 收到选举胜者广播
   */
  onElectionWin(msg) {
    if (!this._electing && msg.from !== this.myName) return;
    this._electing = false;
    clearTimeout(this._fallbackTimer);

    const { newHub } = msg.payload || {};
    if (newHub && newHub !== this.myName) {
      console.log(`[election] ${newHub} 当选临时 Hub，切换连接`);
      this.emit('new-hub', newHub);
    }
  }

  /**
   * Hub 恢复上线（原 Hub 或更高优先级的 Hub）
   */
  onHubRestored(hubName) {
    this._electing = false;
    clearTimeout(this._electionTimer);
    clearTimeout(this._fallbackTimer);
    console.log(`[election] Hub ${hubName} 已恢复，回归正常模式`);
    this.emit('hub-restored', hubName);
  }

  // 简单的 Ping：向目标节点发 query，等 3s 看有没有响应
  _pingNode(nodeName) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      this.once(`pong-${nodeName}`, () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.send(createMsg(MSG.QUERY, this.myName, nodeName, { ping: true }));
    });
  }

  receivePong(fromName) {
    this.emit(`pong-${fromName}`);
  }
}

/**
 * 在线率追踪器 — 各节点自己维护，不依赖 Hub
 *
 * 每次注册（或重连）记录起点，心跳丢失时记录离线段，
 * 在线率 = 在线时长 / 总注册时长
 */
class UptimeTracker {
  constructor() {
    this._registeredAt  = null;   // 首次注册时间
    this._onlineDuration = 0;     // 累计在线毫秒
    this._sessionStart  = null;   // 当前连接段起点
  }

  onConnected() {
    const now = Date.now();
    if (!this._registeredAt) this._registeredAt = now;
    this._sessionStart = now;
  }

  onDisconnected() {
    if (this._sessionStart) {
      this._onlineDuration += Date.now() - this._sessionStart;
      this._sessionStart = null;
    }
  }

  /** 返回 0~1 的在线率 */
  getRate() {
    if (!this._registeredAt) return 0;
    const total   = Date.now() - this._registeredAt;
    const online  = this._onlineDuration + (this._sessionStart
      ? Date.now() - this._sessionStart : 0);
    return total > 0 ? online / total : 0;
  }

  toJSON() {
    return {
      registeredAt:    this._registeredAt,
      onlineDuration:  this._onlineDuration,
      rate:            this.getRate(),
    };
  }
}

module.exports = { ElectionManager, UptimeTracker };
