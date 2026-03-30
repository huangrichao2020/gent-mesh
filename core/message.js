/**
 * core/message.js — 消息帧格式定义
 *
 * 所有节点之间通信使用统一的 JSON 消息帧。
 * Agent 学习此文件即可理解如何收发消息。
 */

const { randomUUID } = require('crypto');

// ── 消息类型枚举 ──
const MSG = {
  // 连接管理
  REGISTER:      'register',       // Spoke → Hub：节点注册
  REGISTER_ACK:  'register_ack',   // Hub → Spoke：注册确认
  HEARTBEAT:     'heartbeat',      // 双向：心跳
  HEARTBEAT_ACK: 'heartbeat_ack',  // 双向：心跳响应
  DISCONNECT:    'disconnect',     // 节点主动断开通知

  // 任务流
  TASK_ASSIGN:   'task_assign',    // Hub → Spoke：派发任务
  TASK_ACK:      'task_ack',       // Spoke → Hub：确认接收任务
  STREAM_CHUNK:  'stream_chunk',   // 双向：流式输出片段
  STREAM_DONE:   'stream_done',    // 双向：本轮流结束
  INTERRUPT:     'interrupt',      // Hub → Spoke：打断当前任务

  // 节点主动发起
  QUERY:         'query',          // Spoke → Hub：主动询问
  REPORT:        'report',         // Spoke → Hub：主动汇报状态

  // 选举（Hub 故障转移）
  ELECTION_CALL: 'election_call',  // 广播选举邀请（携带自己在线率）
  ELECTION_WIN:  'election_win',   // 广播自己当选临时 Hub
  NODES_LIST:    'nodes_list',     // Hub → Spoke：当前在线节点列表
};

/**
 * 构造消息帧
 * @param {string} type     消息类型，见 MSG 枚举
 * @param {string} from     发送方节点名
 * @param {string} to       目标节点名（'hub' 或具体节点名，'*' 广播）
 * @param {*}      payload  消息内容
 * @param {object} opts     可选附加字段
 */
function createMsg(type, from, to, payload = null, opts = {}) {
  return {
    id:        opts.id       || randomUUID(),
    session:   opts.session  || null,   // 关联的任务 session ID
    type,
    from,
    to,
    payload,
    ts:        Date.now(),
    done:      opts.done     ?? null,   // 仅 stream_chunk 使用
  };
}

/**
 * 解析收到的消息帧，失败返回 null
 */
function parseMsg(raw) {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg.type || !msg.from) return null;
    return msg;
  } catch {
    return null;
  }
}

module.exports = { MSG, createMsg, parseMsg };
