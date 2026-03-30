#!/usr/bin/env node
/**
 * mesh.js — agent-mesh 主入口
 *
 * 用法：
 *   mesh init     — 初始化配置（角色、Hub 地址等）
 *   mesh start    — 启动（Hub 或 Spoke）
 *   mesh doctor   — 环境检测
 *   mesh nodes    — 查看当前在线节点（Hub 模式）
 *   mesh send     — 向节点发送消息
 */

const chalk    = require('chalk');
const inquirer = require('inquirer');
const os       = require('os');
const fetch    = require('node-fetch');

const cfg     = require('./config/mesh.config');
const { runDoctor }  = require('./core/doctor');
const { Hub }        = require('./core/hub');
const { Spoke }      = require('./core/spoke');
const { detectHubNetwork, getLocalIPs } = require('./core/detect');

const [,, cmd, ...args] = process.argv;

async function main() {
  switch (cmd) {
    case 'init':   return runInit();
    case 'start':  return runStart();
    case 'doctor': return runDoctor();
    case 'nodes':  return runNodes();
    case 'send':   return runSend(args);
    default:
      printHelp();
  }
}

// ──────────────────────────────────────────
// mesh init
// ──────────────────────────────────────────
async function runInit() {
  console.log(chalk.bold.cyan('\n🔧  agent-mesh 初始化\n'));

  const { role } = await inquirer.prompt([{
    type: 'list',
    name: 'role',
    message: '这台设备的角色是？',
    choices: [
      { name: '🖥️  Hub（中枢）— 主设备，负责调度所有节点', value: 'hub' },
      { name: '🔌  Spoke（节点）— 从设备，接受中枢调度', value: 'spoke' },
    ],
  }]);

  if (role === 'hub') {
    await initHub();
  } else {
    await initSpoke();
  }
}

async function initHub() {
  const ips = getLocalIPs();
  const ipChoices = ips.map(i => ({ name: `${i.name}: ${i.address}`, value: i.address }));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Hub 节点名称？',
      default: `hub-${os.hostname()}`,
    },
    {
      type: 'input',
      name: 'wsPort',
      message: 'WebSocket 端口？',
      default: '7700',
      validate: v => /^\d+$/.test(v) ? true : '请输入数字',
    },
    {
      type: 'input',
      name: 'apiPort',
      message: 'API 管理端口？',
      default: '7701',
      validate: v => /^\d+$/.test(v) ? true : '请输入数字',
    },
    {
      type: 'list',
      name: 'agent',
      message: '本机使用的 Agent CLI？',
      choices: ['claude', 'qwen', 'codex', '自定义'],
    },
  ]);

  // 生成 token
  const { randomUUID } = require('crypto');
  const token = 'hub_' + randomUUID().replace(/-/g, '').slice(0, 20);

  const config = {
    role:     'hub',
    name:     answers.name,
    wsPort:   parseInt(answers.wsPort),
    apiPort:  parseInt(answers.apiPort),
    agent:    answers.agent,
    hubToken: token,
  };

  cfg.save(config);

  console.log(chalk.bold.green('\n✅  Hub 配置已保存\n'));
  console.log(chalk.cyan('  Token（其他节点连接时填写）：'));
  console.log(chalk.bold.white(`  ${token}\n`));

  if (ips.length > 0) {
    console.log(chalk.cyan('  局域网地址：'));
    ips.forEach(i => console.log(`    ws://${i.address}:${answers.wsPort}`));
  }
  console.log(chalk.gray('\n  运行 mesh start 启动 Hub'));
}

async function initSpoke() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: '这台设备的节点名称？',
      default: `spoke-${os.hostname()}`,
    },
    {
      type: 'input',
      name: 'hubUrl',
      message: 'Hub 的 WebSocket 地址？',
      default: 'ws://192.168.1.x:7700',
      validate: v => v.startsWith('ws') ? true : '格式应为 ws:// 或 wss://',
    },
    {
      type: 'input',
      name: 'hubToken',
      message: 'Hub Token？',
      validate: v => v.length > 5 ? true : 'Token 太短',
    },
    {
      type: 'list',
      name: 'agent',
      message: '本机使用的 Agent CLI？',
      choices: ['claude', 'qwen', 'codex', '自定义'],
    },
    {
      type: 'input',
      name: 'backupHubs',
      message: '备用 Hub 节点名（故障转移顺序，多个用逗号分，留空=仅用在线率选举）',
      default: '',
    },
  ]);

  // 自动检测网络类型
  const netType = await detectHubNetwork(answers.hubUrl);
  console.log(chalk.cyan(`\n  检测到网络类型: ${netType === 'lan' ? '局域网 ✅' : '公网 ⚠️'}`));

  if (netType === 'wan') {
    console.log(chalk.yellow(
      '  公网节点需要反向 SSH 隧道，请在 Hub 设备上运行：\n' +
      `  ssh -R 7700:localhost:7700 -R 7701:localhost:7701 root@<本机公网IP> -N`
    ));
  }

  const backupHubs = answers.backupHubs
    ? answers.backupHubs.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  cfg.save({
    role:       'spoke',
    name:       answers.name,
    hubUrl:     answers.hubUrl,
    hubToken:   answers.hubToken,
    agent:      answers.agent,
    backupHubs,
    netType,
  });

  console.log(chalk.bold.green('\n✅  Spoke 配置已保存'));
  if (backupHubs.length) {
    console.log(chalk.gray(`  🔄 备用 Hub 顺序: ${backupHubs.join(' → ')} → 在线率选举`));
  } else {
    console.log(chalk.gray(`  🔄 无预设备用 Hub，Hub 故障时直接进行在线率选举`));
  }
  console.log(chalk.gray('  运行 mesh start 连接 Hub\n'));
}

// ──────────────────────────────────────────
// mesh start
// ──────────────────────────────────────────
async function runStart() {
  if (!cfg.isConfigured()) {
    console.log(chalk.yellow('⚠️  尚未初始化，请先运行: mesh init\n'));
    process.exit(1);
  }

  const config = cfg.load();

  if (config.role === 'hub') {
    const hub = new Hub(config);
    await hub.start();

    // 保存 token（init 时已存，但确保一致）
    cfg.set('hubToken', hub.token);

    // 优雅退出
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\nHub 正在关闭...'));
      process.exit(0);
    });

  } else if (config.role === 'spoke') {
    const spoke = new Spoke(config);

    // 收到任务时的处理（示例：打印出来，实际接入 Agent CLI）
    spoke.on('task_assign', (msg) => {
      console.log(chalk.cyan(`\n  📥 收到任务 [${msg.session}]：`));
      console.log(chalk.white(`  ${JSON.stringify(msg.payload, null, 2)}`));
      // TODO: 接入 Agent CLI，流式输出结果
      spoke.sendChunk(msg.from, '正在处理...', msg.session);
      spoke.sendDone(msg.from, msg.session);
    });

    await spoke.start();

    process.on('SIGINT', () => {
      spoke.disconnect();
      console.log(chalk.yellow('\nSpoke 已断开'));
      process.exit(0);
    });
  }
}

// ──────────────────────────────────────────
// mesh nodes
// ──────────────────────────────────────────
async function runNodes() {
  const config = cfg.load();
  if (config.role !== 'hub') {
    // Spoke 也可以通过 API 查询
  }
  const apiPort = config.apiPort || 7701;
  try {
    const res  = await fetch(`http://localhost:${apiPort}/nodes`, {
      headers: { 'x-token': config.hubToken },
    });
    const data = await res.json();
    console.log(chalk.bold(`\n在线节点 (${data.count})`));
    if (data.count === 0) {
      console.log(chalk.gray('  暂无节点在线'));
    } else {
      data.nodes.forEach(n => {
        console.log(
          chalk.green(`  ● ${n.name}`) +
          chalk.gray(` [${n.agent}] ${n.ip}`)
        );
      });
    }
    console.log('');
  } catch {
    console.error(chalk.red('无法连接 Hub API，请确认 Hub 正在运行'));
  }
}

// ──────────────────────────────────────────
// mesh send <to> <message>
// ──────────────────────────────────────────
async function runSend([to, ...msgParts]) {
  if (!to || msgParts.length === 0) {
    console.log(chalk.yellow('用法: mesh send <节点名> <消息内容>'));
    return;
  }
  const config  = cfg.load();
  const apiPort = config.apiPort || 7701;
  const payload = msgParts.join(' ');

  try {
    const res  = await fetch(`http://localhost:${apiPort}/send`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-token': config.hubToken },
      body:    JSON.stringify({ to, payload }),
    });
    const data = await res.json();
    console.log(chalk.green(`✅ 已发送 [${data.msgId}]`));
  } catch {
    console.error(chalk.red('发送失败，请确认 Hub 正在运行'));
  }
}

function printHelp() {
  console.log(chalk.bold('\nagent-mesh — 多设备 Agent 通信网格\n'));
  console.log('  mesh init      初始化（设置角色、Hub 地址）');
  console.log('  mesh start     启动（Hub 或 Spoke）');
  console.log('  mesh doctor    环境检测');
  console.log('  mesh nodes     查看在线节点');
  console.log('  mesh send      向节点发送消息');
  console.log('');
}

main().catch(err => {
  console.error(chalk.red(`\n错误: ${err.message}\n`));
  process.exit(1);
});
