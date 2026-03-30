/**
 * core/doctor.js — 环境检测
 * 运行 mesh doctor 时执行，输出详细诊断报告
 */

const { execSync, exec } = require('child_process');
const { isPortInUse, checkInternet, getLocalIPs } = require('./detect');
const chalk = require('chalk');

const WS_PORT  = 7700;
const API_PORT = 7701;

function cmd(command) {
  try { return execSync(command, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function ok(msg)   { console.log(chalk.green('  ✅ ') + msg); }
function warn(msg) { console.log(chalk.yellow('  ⚠️  ') + msg); }
function fail(msg) { console.log(chalk.red('  ❌ ') + msg); }
function info(msg) { console.log(chalk.gray('     ') + msg); }
function section(title) {
  console.log('\n' + chalk.bold.cyan(`[${title}]`));
}

async function runDoctor() {
  console.log(chalk.bold('\n🔍  agent-mesh 环境检测\n'));

  // ── 网络 ──
  section('网络');

  const ips = getLocalIPs();
  if (ips.length > 0) {
    ok(`本机网络接口：`);
    ips.forEach(i => info(`${i.name}: ${i.address}`));
  } else {
    warn('未检测到活跃的网络接口');
  }

  const internet = await checkInternet();
  internet ? ok('外网连通性：正常') : fail('外网连通性：不可达（请检查网络）');

  // ── 端口 ──
  section('端口');

  const p7700 = await isPortInUse(WS_PORT);
  const p7701 = await isPortInUse(API_PORT);

  p7700 ? warn(`7700 (WebSocket) 已被占用`) : ok(`7700 (WebSocket) 可用`);
  p7701 ? warn(`7701 (API管理)  已被占用`) : ok(`7701 (API管理)  可用`);

  // 防火墙提示
  const os = process.platform;
  if (os === 'linux') {
    info('Linux 用户请确认防火墙已放行：');
    info('  sudo ufw allow 7700/tcp && sudo ufw allow 7701/tcp');
    info('  或：firewall-cmd --add-port=7700/tcp --permanent');
  } else if (os === 'darwin') {
    info('macOS：系统偏好设置 → 安全性 → 防火墙 → 确认允许传入连接');
  }

  // ── 依赖 ──
  section('依赖');

  const nodeVer = cmd('node --version');
  if (nodeVer) {
    const major = parseInt(nodeVer.replace('v', '').split('.')[0]);
    major >= 18
      ? ok(`Node.js ${nodeVer}`)
      : fail(`Node.js ${nodeVer}（需要 >= 18，请升级）`);
  } else {
    fail('Node.js 未找到');
  }

  const agents = {
    'claude': 'claude --version',
    'qwen':   'qwen --version',
    'codex':  'codex --version',
  };

  for (const [name, vcmd] of Object.entries(agents)) {
    const ver = cmd(vcmd);
    ver ? ok(`${name} CLI：${ver.split('\n')[0]}`) : warn(`${name} CLI 未安装（如需连接 ${name} 节点请安装）`);
  }

  // ── SSH ──
  section('SSH 隧道（公网节点需要）');

  const sshOk = cmd('ssh -V');
  sshOk ? ok(`ssh 可用：${sshOk}`) : fail('ssh 命令未找到');

  // 检测是否有活跃的反向隧道
  let hasTunnel = false;
  try {
    const lsof = cmd(`lsof -i :${WS_PORT} -n -P 2>/dev/null | grep LISTEN`);
    if (lsof && lsof.includes('ssh')) hasTunnel = true;
  } catch {}

  hasTunnel
    ? ok('检测到活跃的 SSH 隧道')
    : warn('未检测到 SSH 反向隧道（若有公网节点需要建立）');

  info('建立反向隧道命令示例：');
  info(`  ssh -R ${WS_PORT}:localhost:${WS_PORT} -R ${API_PORT}:localhost:${API_PORT} root@your-server -N`);

  // ── 总结 ──
  console.log('\n' + chalk.bold('─'.repeat(50)));
  console.log(chalk.bold('检测完成。如有 ❌ 请先修复后再启动。\n'));
}

module.exports = { runDoctor };
