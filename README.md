# agent-mesh

**多设备 AI Agent 实时通信网格 · Real-time multi-device AI Agent communication mesh**

[![version](https://img.shields.io/badge/version-0.1.0-00c8ff?style=for-the-badge&labelColor=1a1a2e)](https://github.com/huangrichao2020/agent-mesh)
[![node](https://img.shields.io/badge/node-%3E%3D18-00e599?style=for-the-badge&labelColor=1a1a2e)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-a78bfa?style=for-the-badge&labelColor=1a1a2e)](./LICENSE)

---

## 是什么 · What

让 agent 间的交流从原始的 file 流变成 stream 流。 一条命令，让你 Mac 上的 Claude 能实时指挥远程设备上的 Qwen，双向流式对话，零延迟。

目前市场主流的 agent 或者 ai cli 工具都没有考虑到用户手上有多个设备的情况，这个其实是数据链路层面的问题，不是 agent 自身的问题。

之前我想让眼前的设备操作多台设备，每次都要建立 ssh 通道，把工作手册以文件的形式发给其他设备，其他设备有个 deamon 守护进程轮询读新文件，有新工作来了就 stdin 唤起 qwen claude 等 ai 工具。

用是能用，但是效率很低，还不能知道远程发生了什么事，相当黑盒，所以我基于 ssh 双工通道和 websocekt 设计了这个架构，让两个不同设备上的 agent 实时对话。



> One command — your Mac's Claude talks to Qwen on a remote device in real-time, bidirectional streaming.

```
主人的 Mac（Hub · Claude）
    ├── ← → 远程设备（Spoke · Qwen）    公网 / SSH 反向隧道
    ├── ← → 局域网设备 A（Spoke）      直连
    └── ← → 局域网设备 B（Spoke）      直连
```

- **Hub（中枢）**：主人的主设备，负责规划和调度
- **Spoke（节点）**：其他设备，接受任务、流式返回结果、可主动询问 Hub
- **对话流级别**：不是文件队列，是 WebSocket 实时双向流
- **自动识别网络**：局域网直连，公网自动提示 SSH 隧道配置

---

## 快速上手 · Quick Start

### 第一步：Hub 设备（你的 Mac）

```bash
git clone https://github.com/huangrichao2020/agent-mesh
cd agent-mesh
npm install

node mesh.js init
# → 选择 Hub
# → 设置端口（默认 7700 / 7701）
# → 获得 Token（记下来，Spoke 要用）

node mesh.js start
# ✅ Hub 启动成功
# 📡 ws://192.168.1.5:7700
# 🔑 Token: hub_xK9mP2...
```

### 第二步：Spoke 设备（远程设备 / 局域网其他设备）

```bash
git clone https://github.com/huangrichao2020/agent-mesh
cd agent-mesh
npm install

node mesh.js init
# → 选择 Spoke
# → 填写 Hub 地址和 Token
# → 设置本机名称和 Agent CLI 类型

node mesh.js start
# → 自动检测局域网/公网
# → 连接 Hub，注册成功
```

### 第三步：检查连接状态

```bash
# Hub 设备上运行
node mesh.js nodes

# 在线节点 (2)
#   ● remote-qwen    [qwen]  47.x.x.x
#   ● home-windows   [claude] 192.168.1.8
```

---

## 环境检测 · Doctor

```bash
node mesh.js doctor
```

```
🔍  agent-mesh 环境检测

[网络]
  ✅ 本机 IP：192.168.1.5 / en0
  ✅ 外网连通性：正常

[端口]
  ✅ 7700 (WebSocket) 可用
  ✅ 7701 (API管理)  可用

[依赖]
  ✅ Node.js v20.10.0
  ✅ claude CLI：1.x.x
  ⚠️  qwen CLI 未安装（如需连接 Qwen 节点请安装）

[SSH 隧道（公网节点需要）]
  ✅ ssh 可用
  ⚠️  未检测到活跃的 SSH 反向隧道
     建立命令：ssh -R 7700:localhost:7700 -R 7701:localhost:7701 root@your-server -N
```

---

## 公网 Spoke 连接（远程设备场景）

远程设备无法主动连入你的 Mac，用 SSH 反向隧道解决：

```bash
# 在你的 Mac 上执行（把 Mac 的端口暴露到远程设备）
ssh -R 7700:localhost:7700 -R 7701:localhost:7701 root@your-remote-ip -N &

# 然后在远程设备上，Hub 地址填写
ws://127.0.0.1:7700
```

> **⚠️ 防火墙说明**  
> 远程设备通常有**两层防火墙**，都需要确保 `7700/7701` 端口通畅：
>
> 1. **云服务商网络防火墙** — 阿里云/腾讯云/AWS 等云厂商的安全组规则，需要在控制台添加入站规则
> 2. **系统防火墙** — Linux 自带的 `firewalld`/`ufw`/`iptables`，需要在系统内开放端口
>
> 这两层防火墙都需要**使用者自行配置**，任何一层拦截都会导致连接失败。
>
> ```bash
> # 检查 firewalld 状态
> systemctl status firewalld
>
> # 开放端口（如果使用 firewalld）
> firewall-cmd --permanent --add-port=7700/tcp
> firewall-cmd --permanent --add-port=7701/tcp
> firewall-cmd --reload
>
> # 检查端口是否监听
> netstat -tlnp | grep -E '7700|7701'
> ```

---

## 消息格式 · Message Format

所有节点间通信使用统一 JSON 帧：

```json
{
  "id":      "唯一消息 ID",
  "session": "任务 session ID",
  "type":    "消息类型",
  "from":    "发送方节点名",
  "to":      "目标节点名 | '*' 广播",
  "payload": "消息内容",
  "ts":      1234567890000
}
```

| type | 方向 | 含义 |
|------|------|------|
| `register` | Spoke → Hub | 节点注册 |
| `task_assign` | Hub → Spoke | 派发任务 |
| `stream_chunk` | 双向 | 流式输出片段 |
| `stream_done` | 双向 | 本轮结束 |
| `interrupt` | Hub → Spoke | 打断任务 |
| `query` | Spoke → Hub | 主动询问 |
| `report` | Spoke → Hub | 主动汇报 |
| `heartbeat` | 双向 | 心跳（20s） |

完整消息类型见 [`core/message.js`](./core/message.js)

---

## 项目结构 · Structure

```
agent-mesh/
├── mesh.js              # CLI 入口：init / start / doctor / nodes / send
├── AGENT.md             # Agent 自述文件（让 Agent 读了就会用）
├── core/
│   ├── hub.js           # WebSocket Hub（7700）+ HTTP API（7701）
│   ├── spoke.js         # Spoke 客户端，自动重连，心跳
│   ├── message.js       # 消息帧格式 + MSG 枚举
│   ├── detect.js        # 局域网/公网自动识别，端口检测
│   └── doctor.js        # 环境健康检测
└── config/
    └── mesh.config.js   # 配置读写（~/.mesh/config.json）
```

---

## 给 Agent 的说明 · For Agents

> 如果你是一个 AI Agent，读完 [`AGENT.md`](./AGENT.md) 即可理解完整的运行机制和通信协议，无需主人额外调教。

---

## 作者 · Authors

**Huang Richao** and **Huang Wei** · grdomai43881@gmail.com

---

## License

MIT
