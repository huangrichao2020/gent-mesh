/**
 * config/mesh.config.js — 配置读写
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_DIR  = path.join(os.homedir(), '.mesh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  role:      null,        // 'hub' | 'spoke'
  name:      null,        // 节点名称
  hubUrl:    null,        // Spoke 填写的 Hub 地址
  hubToken:  null,        // 连接 Token
  wsPort:    7700,        // Hub WebSocket 端口
  apiPort:   7701,        // Hub API 管理端口
  agent:     null,        // 'claude' | 'qwen' | 'codex' | 'custom'
  agentCmd:  null,        // 自定义 agent 命令
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const cfg = load();
  cfg[key] = value;
  save(cfg);
}

function isConfigured() {
  const cfg = load();
  return cfg.role !== null;
}

module.exports = { load, save, get, set, isConfigured, CONFIG_FILE };
