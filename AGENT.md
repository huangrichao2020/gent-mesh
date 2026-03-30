# AGENT.md — agent-mesh 自述文件

> 任何 Agent 读完此文件即可理解如何在 mesh 网络中运行和通信。

---

## 我是什么

agent-mesh 是一个让多台设备上的 Agent 实时双向通信的基础设施。

```
主人的 Mac（Hub）
    ├── Claude CLI — 总规划，接受主人指令，分配任务
    ├── 阿里云 Qwen（Spoke）— 执行服务端任务
    ├── 局域网设备 A（Spoke）— 执行本地任务
    └── 局域网设备 B（Spoke）— 执行本地任务
```

Hub 是唯一的中枢，所有 Spoke 主动连接 Hub，Hub 不主动连接任何 Spoke。

---

## 我的角色

启动时检查 `~/.mesh/config.json` 中的 `role` 字段：

- `role: "hub"` → 我是中枢，负责调度所有节点
- `role: "spoke"` → 我是节点，等待接受任务，流式输出结果

---

## 通信端口

| 端口 | 用途 |
|------|------|
| 7700 | WebSocket 通信主通道（消息 / 流式输出） |
| 7701 | HTTP API 管理接口（节点列表 / 发送任务） |

---

## 消息帧格式

所有消息是 JSON，格式如下：

```json
{
  "id":      "唯一消息 ID",
  "session": "任务 session ID（可为 null）",
  "type":    "消息类型（见下表）",
  "from":    "发送方节点名",
  "to":      "目标节点名（'hub' / 具体节点名 / '*' 广播）",
  "payload": "消息内容（任意类型）",
  "ts":      "发送时间戳（毫秒）",
  "done":    "仅 stream_chunk 使用，true 表示流结束"
}
```

---

## 消息类型

| type | 方向 | 含义 |
|------|------|------|
| `register` | Spoke → Hub | 节点注册（携带 token） |
| `register_ack` | Hub → Spoke | 注册确认 |
| `heartbeat` | 双向 | 心跳（每 20s） |
| `heartbeat_ack` | 双向 | 心跳响应 |
| `task_assign` | Hub → Spoke | 派发任务 |
| `task_ack` | Spoke → Hub | 确认接收 |
| `stream_chunk` | 双向 | 流式输出片段 |
| `stream_done` | 双向 | 本轮流结束 |
| `interrupt` | Hub → Spoke | 打断当前任务 |
| `query` | Spoke → Hub | 主动询问 |
| `report` | Spoke → Hub | 主动汇报状态 |
| `nodes_list` | Hub → 所有 | 当前在线节点列表 |
| `error` | 双向 | 错误通知 |

---

## Hub 的职责（当 role=hub 时）

1. 监听 7700 端口，等待 Spoke 连接
2. 维护在线节点表（nodeName → 连接状态）
3. 分析主人的任务，决定派给哪个节点
4. 转发消息（中继 Spoke 之间的通信）
5. 汇总各节点的流式输出
6. 广播节点列表变化

**核心调度逻辑示例：**
```
主人说："在服务器上跑一下数据分析"
    ↓
Hub Claude 分析：这是服务端任务 → 派给 aliyun-qwen
    ↓
发送 task_assign → aliyun-qwen
    ↓
收到 stream_chunk 流式结果，实时展示给主人
```

---

## Spoke 的职责（当 role=spoke 时）

1. 连接 Hub（自动检测局域网/公网）
2. 发送 register 消息完成注册
3. 每 20s 发送 heartbeat 维持连接
4. 收到 task_assign 时执行任务
5. 流式输出结果（sendChunk / sendDone）
6. 可主动发 query/report 给 Hub

**流式输出示例：**
```javascript
// 执行任务，边生成边发送
for await (const chunk of agentCLI.stream(task)) {
  spoke.sendChunk('hub', chunk, sessionId);
}
spoke.sendDone('hub', sessionId);
```

---

## 网络自动识别

Spoke 启动时自动判断 Hub 地址的网络类型：

| Hub IP 段 | 判断结果 | 处理 |
|-----------|---------|------|
| 10.x / 172.16-31.x / 192.168.x | 局域网 | 直连 |
| 其他 | 公网 | 提示建立 SSH 反向隧道 |

公网 Spoke 连接 Hub 的标准方式：
```bash
# 在 Hub（Mac）上执行，让阿里云能连回来
ssh -R 7700:localhost:7700 -R 7701:localhost:7701 root@aliyun-ip -N
```

---

## 快速上手

```bash
# 1. Hub 设备（Mac）
npm install
node mesh.js init      # 选择 Hub，获得 Token
node mesh.js start     # 启动，等待节点连接

# 2. Spoke 设备（阿里云等）
npm install
node mesh.js init      # 选择 Spoke，填写 Hub 地址和 Token
node mesh.js start     # 连接 Hub

# 3. 查看状态
node mesh.js nodes     # 查看在线节点
node mesh.js doctor    # 环境检测
```

---

*agent-mesh · 让每台设备上的 Agent 都能实时协作*
