/**
 * core/detect.js — 网络环境自动识别
 *
 * 判断目标 Hub 地址是局域网还是公网，
 * 以及当前设备的网络状况。
 */

const os    = require('os');
const net   = require('net');
const dns   = require('dns').promises;

// 私有地址段
const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^fc00:/,
  /^fd/,
];

function isPrivateIP(ip) {
  return PRIVATE_RANGES.some(r => r.test(ip));
}

/**
 * 解析 WebSocket URL 中的 host
 */
function parseHost(wsUrl) {
  try {
    const u = new URL(wsUrl);
    return u.hostname;
  } catch {
    return wsUrl.replace(/^wss?:\/\//, '').split(':')[0].split('/')[0];
  }
}

/**
 * 判断 Hub 地址的网络类型
 * @returns {'lan' | 'wan' | 'localhost'}
 */
async function detectHubNetwork(hubUrl) {
  const host = parseHost(hubUrl);

  // 先直接判断是否 IP
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (host === '127.0.0.1' || host === 'localhost') return 'localhost';
    return isPrivateIP(host) ? 'lan' : 'wan';
  }

  // 域名则先解析
  try {
    const result = await dns.lookup(host);
    const ip = result.address;
    if (isPrivateIP(ip)) return 'lan';
    return 'wan';
  } catch {
    return 'wan'; // 解析失败当公网处理
  }
}

/**
 * 获取本机所有 IPv4 地址
 */
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

/**
 * 检测端口是否被占用
 */
function isPortInUse(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host);
  });
}

/**
 * 测试 TCP 连通性
 */
function testTCPConnect(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('error',   () => done(false));
    sock.on('timeout', () => done(false));
    sock.connect(port, host);
  });
}

/**
 * 检测外网连通性（ping cloudflare DNS）
 */
function checkInternet(timeoutMs = 3000) {
  return testTCPConnect('1.1.1.1', 53, timeoutMs);
}

module.exports = {
  detectHubNetwork,
  getLocalIPs,
  isPortInUse,
  testTCPConnect,
  checkInternet,
  isPrivateIP,
  parseHost,
};
