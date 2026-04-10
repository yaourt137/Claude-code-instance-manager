/**
 * Claude Code Multi-Instance Manager - Backend Server (PTY 模式)
 *
 * 启动方式:
 *   npm install express ws node-pty
 *   node server.js
 */

const express        = require("express");
const http           = require("http");
const WebSocket      = require("ws");
const path           = require("path");
const fs             = require("fs");
const crypto         = require("crypto");
const os             = require("os");
const https          = require("https");
const multer         = require("multer");
const { execSync, exec: execCb } = require("child_process");

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    execCb(cmd, opts, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); }
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

let pty = null;
try {
  pty = require("node-pty");
  console.log("node-pty 加载成功");
} catch (e) {
  console.warn("未找到 node-pty，将使用 Mock 模式");
}

// ─── CLI 配置与路径检测 ─────────────────────────────────────────────────────
const CLI_CONFIGS = {
  claude: { cmd: "claude", label: "Claude Code" },
  codex:  { cmd: "codex",  label: "Codex" },
  gemini: { cmd: "gemini", label: "Gemini CLI" },
};

function detectCLIPath(cmd) {
  const home = process.env.HOME || "";
  try {
    const real = execSync("realpath $(which " + cmd + ") 2>/dev/null").toString().trim();
    if (real) { console.log("找到 " + cmd + ": " + real); return real; }
  } catch (_) {}
  try {
    const p = execSync("which " + cmd + " 2>/dev/null").toString().trim();
    if (p) { console.log("找到 " + cmd + ": " + p); return p; }
  } catch (_) {}
  const candidates = [
    "/opt/homebrew/bin/" + cmd,
    home + "/.npm-global/bin/" + cmd,
    home + "/.local/bin/" + cmd,
    "/usr/local/bin/" + cmd,
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); console.log("找到 " + cmd + ": " + c); return c; } catch (_) {}
  }
  console.warn("未找到 " + cmd + " 命令");
  return null;
}

const CLI_PATHS = {};
for (const [key, cfg] of Object.entries(CLI_CONFIGS)) {
  CLI_PATHS[key] = detectCLIPath(cfg.cmd);
}
const HAS_ANY_CLI = pty && Object.values(CLI_PATHS).some(p => p);

// ─── 终端实例：允许的 shell 命令白名单 ─────────────────────────────────────────
const ALLOWED_SHELL_CMDS = {
  "npm run dev":  { bin: "npm", args: ["run", "dev"],  label: "npm run dev" },
  "npm start":    { bin: "npm", args: ["start"],       label: "npm start" },
};
const NPM_PATH = detectCLIPath("npm");
const HOME = process.env.HOME || os.homedir() || __dirname;
const DESKTOP = path.join(HOME, "Desktop");
const CONFIG_DIR = process.env.MANAGER_DATA_DIR
  ? path.resolve(process.env.MANAGER_DATA_DIR)
  : path.join(HOME, ".claude-code-manager");
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, parseInt(process.env.SESSION_TTL_MS, 10) || (24 * 60 * 60 * 1000));
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const COOKIE_NAME = "session_token";
const BIND_HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const EXTRA_ALLOWED_ORIGINS = String(process.env.MANAGER_ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const DEFAULT_ALLOWED_ROOTS = [HOME];
const ALLOWED_ROOTS = parseAllowedRoots(process.env.MANAGER_ALLOWED_ROOTS);

function ensureDirSync(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (_) {}
}

ensureDirSync(CONFIG_DIR);

function getConfigFilePath(filename) {
  const target = path.join(CONFIG_DIR, filename);
  const legacy = path.join(__dirname, filename);
  if (!fs.existsSync(target) && legacy !== target && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, target);
    } catch (_) {
      try { fs.copyFileSync(legacy, target); } catch (__) {}
    }
  }
  return target;
}

function parseAllowedRoots(raw) {
  const roots = String(raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(expandUserPath);
  return (roots.length ? roots : DEFAULT_ALLOWED_ROOTS)
    .map(p => path.resolve(p))
    .filter(Boolean);
}

function expandUserPath(input) {
  const value = String(input || "").trim();
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isAllowedPath(targetPath) {
  const resolved = path.resolve(targetPath);
  return ALLOWED_ROOTS.some(root => isPathInside(root, resolved));
}

function resolveManagedPath(input, fallbackPath) {
  const raw = String(input || fallbackPath || "").trim() || fallbackPath || DESKTOP;
  const resolved = path.resolve(expandUserPath(raw));
  if (!isAllowedPath(resolved)) {
    throw new Error("路径不在允许范围内");
  }
  return resolved;
}

function getRequestIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function createRateLimiter(windowMs, maxAttempts) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = getRequestIP(req);
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > maxAttempts) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "请求过于频繁，请稍后重试" });
    }
    next();
  };
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isRequestSecure(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https" || !!req.socket?.encrypted;
}

function getAllowedHosts(req) {
  const hosts = new Set();
  const reqHost = String(req.headers.host || "").trim().toLowerCase();
  if (reqHost) hosts.add(reqHost);
  if (PUBLIC_BASE_URL) {
    try { hosts.add(new URL(PUBLIC_BASE_URL).host.toLowerCase()); } catch (_) {}
  }
  if (tunnelState.url) {
    try { hosts.add(new URL(tunnelState.url).host.toLowerCase()); } catch (_) {}
  }
  for (const origin of EXTRA_ALLOWED_ORIGINS) {
    try { hosts.add(new URL(origin).host.toLowerCase()); } catch (_) {}
  }
  const port = process.env.PORT || 3000;
  hosts.add("127.0.0.1:" + port);
  hosts.add("localhost:" + port);
  getLocalIPs().forEach(ip => hosts.add(ip + ":" + port));
  return hosts;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const normalizedOrigin = parsed.origin.toLowerCase();
    if (EXTRA_ALLOWED_ORIGINS.some(item => item.toLowerCase() === normalizedOrigin)) return true;
    return getAllowedHosts(req).has(parsed.host.toLowerCase());
  } catch (_) {
    return false;
  }
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: isRequestSecure(req),
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: isRequestSecure(req),
    path: "/",
  });
}

// ─── Cloudflare Tunnel ──────────────────────────────────────────────────────
const TUNNEL_AUTO_START = process.env.TUNNEL === "1" || process.env.TUNNEL === "true";
let tunnelState = { enabled: TUNNEL_AUTO_START, status: "idle", url: null, process: null, available: false };

function detectCloudflared() {
  const candidates = [
    "cloudflared",
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    (process.env.HOME || "") + "/.cloudflared/cloudflared",
  ];
  for (const cmd of candidates) {
    try {
      execSync("which " + cmd + " 2>/dev/null");
      return cmd;
    } catch (_) {}
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch (_) {}
  }
  return null;
}

let _tunnelPort = 3000;

function startTunnel(port) {
  if (port) _tunnelPort = port;
  const cloudflared = detectCloudflared();
  if (!cloudflared) {
    console.log("[tunnel] cloudflared 未安装，跳过隧道创建");
    console.log("[tunnel] 安装方式: brew install cloudflared");
    tunnelState.available = false;
    tunnelState.enabled = false;
    return;
  }
  tunnelState.available = true;

  if (!tunnelState.enabled) return;
  if (tunnelState.process) return; // 已在运行

  tunnelState.status = "connecting";
  tunnelState.url = null;
  console.log("[tunnel] 正在创建 Cloudflare Tunnel...");

  const child = execCb(
    cloudflared + " tunnel --url http://localhost:" + _tunnelPort + " --no-autoupdate 2>&1",
    { maxBuffer: 10 * 1024 * 1024 },
    (err) => {
      if (err && tunnelState.status !== "idle") {
        console.warn("[tunnel] 进程退出:", err.message);
        tunnelState.status = "disconnected";
        tunnelState.url = null;
        tunnelState.process = null;
        // 仅当 enabled 时才自动重连
        if (tunnelState.enabled) {
          setTimeout(() => {
            if (tunnelState.enabled && tunnelState.status === "disconnected") {
              startTunnel();
            }
          }, 10000);
        }
      }
    }
  );

  tunnelState.process = child;

  child.stdout.on("data", (data) => {
    const output = data.toString();
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelState.url) {
      tunnelState.url = match[0];
      tunnelState.status = "connected";
      console.log("[tunnel] 远程访问地址: " + tunnelState.url);
    }
  });
}

function stopTunnel() {
  if (tunnelState.process) {
    tunnelState.status = "idle";
    try { tunnelState.process.kill(); } catch (_) {}
    tunnelState.process = null;
    tunnelState.url = null;
  }
}

// ─── Git 工具函数 ────────────────────────────────────────────────────────────
async function getGitInfo(dirPath) {
  try {
    const opts = { cwd: dirPath, timeout: 5000 };
    await execAsync("git rev-parse --is-inside-work-tree", opts);
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", opts);
    const { stdout: branchList } = await execAsync("git branch --format='%(refname:short)'", opts);
    const { stdout: remoteList } = await execAsync("git remote", opts);
    const { stdout: repoRoot } = await execAsync("git rev-parse --show-toplevel", opts);
    return {
      isGitRepo: true,
      repoRoot: repoRoot.trim(),
      currentBranch: branch.trim(),
      branches: branchList.trim().split("\n").map(s => s.trim().replace(/^'|'$/g, "")).filter(Boolean),
      remotes: remoteList.trim().split("\n").filter(Boolean),
    };
  } catch (_) {
    return { isGitRepo: false };
  }
}

async function createWorktree(repoPath, worktreePath, branchName) {
  const gitignorePath = path.join(repoPath, ".gitignore");
  let content = "";
  try { content = fs.readFileSync(gitignorePath, "utf-8"); } catch (_) {}
  if (!content.includes(".worktrees/")) {
    const nl = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignorePath, nl + ".worktrees/\n");
  }
  const worktreesDir = path.join(repoPath, ".worktrees");
  if (!fs.existsSync(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true });
  await execAsync(
    "git worktree add " + JSON.stringify(worktreePath) + " -b " + JSON.stringify(branchName),
    { cwd: repoPath, timeout: 15000 }
  );
}

async function removeWorktree(repoPath, worktreePath) {
  await execAsync("git worktree remove " + JSON.stringify(worktreePath) + " --force",
    { cwd: repoPath, timeout: 10000 });
}

async function deleteBranch(repoPath, branchName) {
  await execAsync("git branch -D " + JSON.stringify(branchName),
    { cwd: repoPath, timeout: 5000 });
}

async function mergeWorktreeBranch(repoPath, branchName, baseBranch) {
  const opts = { cwd: repoPath, timeout: 30000 };
  // 先保存当前分支以便恢复
  const { stdout: origBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", opts);
  const origRef = origBranch.trim();
  await execAsync("git checkout " + JSON.stringify(baseBranch), opts);
  try {
    const result = await execAsync("git merge " + JSON.stringify(branchName), opts);
    // 合并成功后恢复到原分支
    try { await execAsync("git checkout " + JSON.stringify(origRef), opts); } catch (_) {}
    return { success: true, output: result.stdout };
  } catch (err) {
    try {
      const { stdout } = await execAsync("git diff --name-only --diff-filter=U", opts);
      const conflictFiles = stdout.trim().split("\n").filter(Boolean);
      await execAsync("git merge --abort", opts);
      // 恢复到原分支
      try { await execAsync("git checkout " + JSON.stringify(origRef), opts); } catch (_) {}
      return { success: false, conflicts: conflictFiles };
    } catch (_) {
      try { await execAsync("git merge --abort", opts); } catch (__) {}
      try { await execAsync("git checkout " + JSON.stringify(origRef), opts); } catch (__) {}
      return { success: false, conflicts: [], error: err.message };
    }
  }
}

async function pushBranch(repoPath, branchName, remote) {
  remote = remote || "origin";
  const opts = { cwd: repoPath, timeout: 30000 };
  const result = await execAsync(
    "git push " + JSON.stringify(remote) + " " + JSON.stringify(branchName), opts);
  return { success: true, output: (result.stdout + " " + result.stderr).trim() };
}

// ─── 最近目录记录 ────────────────────────────────────────────────────────────
const RECENT_DIRS_PATH = getConfigFilePath("recent-dirs.json");
const RECENT_DIRS_MAX = 30;

function loadRecentDirs() {
  try {
    if (fs.existsSync(RECENT_DIRS_PATH)) {
      return JSON.parse(fs.readFileSync(RECENT_DIRS_PATH, "utf-8"))
        .filter(d => d && d.path && isAllowedPath(d.path));
    }
  } catch (_) {}
  return [];
}

function saveRecentDir(dirPath) {
  if (!dirPath) return;
  const dirs = loadRecentDirs();
  const now = new Date().toISOString();
  const idx = dirs.findIndex(d => d.path === dirPath);
  if (idx >= 0) {
    dirs[idx].lastUsed = now;
    dirs[idx].count = (dirs[idx].count || 1) + 1;
  } else {
    dirs.unshift({ path: dirPath, lastUsed: now, count: 1 });
  }
  dirs.sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));
  const trimmed = dirs.slice(0, RECENT_DIRS_MAX);
  try { fs.writeFileSync(RECENT_DIRS_PATH, JSON.stringify(trimmed, null, 2), "utf-8"); } catch (_) {}
}

function scanClaudeProjectDirs() {
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  const result = [];
  try {
    if (!fs.existsSync(claudeProjectsDir)) return result;
    const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== "memory");
    for (const pd of projectDirs) {
      const sessionDir = path.join(claudeProjectsDir, pd.name);
      // 找最新的 JSONL 文件，读取其中的 cwd
      let latestMtime = 0;
      let latestFile = null;
      try {
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(sessionDir, f));
            if (stat.mtimeMs > latestMtime) { latestMtime = stat.mtimeMs; latestFile = path.join(sessionDir, f); }
          } catch (_) {}
        }
      } catch (_) {}
      if (!latestFile) continue;
      // 从 JSONL 中提取 cwd
      try {
        const fd = fs.openSync(latestFile, "r");
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const lines = buf.slice(0, bytesRead).toString("utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.cwd && isAllowedPath(obj.cwd)) {
              result.push({ path: obj.cwd, lastUsed: new Date(latestMtime).toISOString(), source: "claude" });
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  return result;
}

// ─── 认证模块 ──────────────────────────────────────────────────────────────────
const AUTH_SETTINGS_PATH = getConfigFilePath("auth-settings.json");
const loginRateLimiter = createRateLimiter(LOGIN_RATE_LIMIT_WINDOW_MS, 10);
const passwordRateLimiter = createRateLimiter(PASSWORD_RATE_LIMIT_WINDOW_MS, 8);

function hashPassword(plain, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(plain, storedHash, storedSalt) {
  try {
    const { hash } = hashPassword(plain, storedSalt);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(storedHash, "hex"));
  } catch (_) { return false; }
}

function loadAuthSettings() {
  try {
    if (!fs.existsSync(AUTH_SETTINGS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_SETTINGS_PATH, "utf-8"));
    if (data.hash && data.salt) return data;
    // 迁移：旧版明文密码 -> scrypt 哈希
    if (data.password) {
      const migrated = hashPassword(data.password);
      fs.writeFileSync(AUTH_SETTINGS_PATH, JSON.stringify(migrated, null, 2), "utf-8");
      console.log("auth-settings.json 已从明文迁移到 scrypt 哈希");
      return migrated;
    }
  } catch (_) {}
  return null;
}

function saveAuthSettings(plain) {
  const result = hashPassword(plain);
  fs.writeFileSync(AUTH_SETTINGS_PATH, JSON.stringify(result, null, 2), "utf-8");
  return result;
}

const _savedAuth = loadAuthSettings();
let AUTH_HASH, AUTH_SALT;
let AUTH_PASSWORD_IS_AUTO = false;
let _autoGenPassword = null;

if (process.env.AUTH_PASSWORD) {
  ({ hash: AUTH_HASH, salt: AUTH_SALT } = hashPassword(process.env.AUTH_PASSWORD));
} else if (_savedAuth) {
  AUTH_HASH = _savedAuth.hash;
  AUTH_SALT = _savedAuth.salt;
} else {
  _autoGenPassword = crypto.randomBytes(6).toString("hex");
  ({ hash: AUTH_HASH, salt: AUTH_SALT } = hashPassword(_autoGenPassword));
  AUTH_PASSWORD_IS_AUTO = true;
}
const sessions = new Map(); // token -> session meta

function clearExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) sessions.delete(token);
  }
}

function createSession() {
  clearExpiredSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSessionByToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function touchSession(token) {
  const session = getSessionByToken(token);
  if (!session) return null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function revokeSession(token) {
  if (token) sessions.delete(token);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
  });
  return cookies;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

function isAuthenticated(req) {
  return !!getSessionByToken(getSessionToken(req));
}

function originMiddleware(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (isAllowedOrigin(req)) return next();
  res.status(403).json({ error: "请求来源不被允许" });
}

function authMiddleware(req, res, next) {
  // 登录接口和认证检查接口不需要鉴权
  if (req.path === "/api/login" || req.path === "/api/auth-check") return next();
  // 静态文件中只放行 index.html 和必要资源（未认证时前端需要加载登录界面）
  if (req.method === "GET" && (req.path === "/" || req.path === "/index.html" || req.path === "/manifest.json" || req.path === "/sw.js" || req.path.startsWith("/icon-"))) return next();
  const token = getSessionToken(req);
  if (getSessionByToken(token)) {
    touchSession(token);
    req.sessionToken = token;
    setSessionCookie(req, res, token);
    return next();
  }
  res.status(401).json({ error: "未授权，请先登录" });
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

setInterval(clearExpiredSessions, 5 * 60 * 1000).unref();

// ─── AI 解释模块 ────────────────────────────────────────────────────────────
const AI_SETTINGS_PATH = getConfigFilePath("ai-settings.json");

function loadAISettings() {
  try {
    if (fs.existsSync(AI_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(AI_SETTINGS_PATH, "utf-8"));
    }
  } catch (e) {
    console.warn("[AI Settings] 读取失败:", e.message);
  }
  return { provider: "openai", apiKey: "", model: "" };
}

function saveAISettings(settings) {
  const safe = {
    provider: String(settings.provider || "openai"),
    apiKey: String(settings.apiKey || ""),
    model: String(settings.model || ""),
  };
  fs.writeFileSync(AI_SETTINGS_PATH, JSON.stringify(safe, null, 2), "utf-8");
  return safe;
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
            .replace(/\x1B\].*?\x07/g, "")
            .replace(/\x1B[()][AB012]/g, "")
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function extractRecentContext(output, maxChars) {
  maxChars = maxChars || 3000;
  const clean = stripAnsi(output);
  const tail = clean.slice(-maxChars);
  const firstNewline = tail.indexOf("\n");
  return firstNewline > 0 && firstNewline < 200 ? tail.slice(firstNewline + 1) : tail;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("JSON 解析失败")); }
        } else {
          let errMsg = "HTTP " + res.statusCode;
          try {
            const p = JSON.parse(data);
            errMsg += ": " + (p.error?.message || JSON.stringify(p.error) || data.slice(0, 200));
          } catch (_) { errMsg += ": " + data.slice(0, 200); }
          reject(new Error(errMsg));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

const DEFAULT_MODELS = { openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-20250514" };

async function callOpenAI(settings, systemPrompt, userPrompt) {
  const model = settings.model || DEFAULT_MODELS.openai;
  const data = await httpPost(
    "https://api.openai.com/v1/chat/completions",
    { Authorization: "Bearer " + settings.apiKey },
    { model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], max_tokens: 1024, temperature: 0.3 }
  );
  return data.choices?.[0]?.message?.content || "无法获取解释";
}

async function callAnthropic(settings, systemPrompt, userPrompt) {
  const model = settings.model || DEFAULT_MODELS.anthropic;
  const data = await httpPost(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" },
    { model, max_tokens: 1024, system: systemPrompt, messages: [{ role: "user", content: userPrompt }], temperature: 0.3 }
  );
  return data.content?.[0]?.text || "无法获取解释";
}

class InstanceManager {
  constructor() {
    this.instances   = new Map();
    this.subscribers = new Map();
    this.ptys        = new Map();
  }

  subscribe(instanceId, ws) {
    if (!this.subscribers.has(instanceId)) this.subscribers.set(instanceId, new Set());
    this.subscribers.get(instanceId).add(ws);
    if (instanceId === "__global__") return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    ws.send(JSON.stringify({ type: "snapshot", instanceId, data: this._serialize(inst) }));
    const output = inst.output || "";
    console.log("[subscribe] " + instanceId + " output.length=" + output.length);
    if (output.length > 0) {
      ws.send(JSON.stringify({ type: "pty_replay", instanceId, data: output }));
    }
  }

  unsubscribe(instanceId, ws) { this.subscribers.get(instanceId)?.delete(ws); }

  broadcast(instanceId, payload) {
    const subs = this.subscribers.get(instanceId);
    if (!subs) return;
    const msg = JSON.stringify({ instanceId, ...payload });
    subs.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  }

  broadcastAll(payload) {
    const msg = JSON.stringify(payload);
    ["__global__", ...this.instances.keys()].forEach(id => {
      this.subscribers.get(id)?.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
    });
  }

  async startInstance({ id, prompt, cwd, label, cliType, worktree, cliArgs, role }) {
    if (this.instances.has(id)) throw new Error("实例 " + id + " 已存在");
    const type = (cliType && CLI_CONFIGS[cliType]) ? cliType : "claude";
    const isOrchestrator = role === "orchestrator";
    const resolvedCwd = resolveManagedPath(cwd || "", DESKTOP);
    const cwdStat = fs.statSync(resolvedCwd);
    if (!cwdStat.isDirectory()) throw new Error("工作目录不存在");

    // Orchestrator: 生成 MCP 配置并注入 CLI 参数
    let mcpConfigPath = null;
    if (isOrchestrator && type === "claude") {
      const sessionToken = createSession();
      const mcpConfig = {
        mcpServers: {
          "instance-manager": {
            command: "node",
            args: [path.join(__dirname, "mcp-server.mjs")],
            env: {
              MANAGER_PORT: String(PORT),
              MANAGER_SESSION: sessionToken,
            },
          },
        },
      };
      mcpConfigPath = path.join(os.tmpdir(), "orchestrator-mcp-" + id + ".json");
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      console.log("[orchestrator] MCP 配置已写入: " + mcpConfigPath);
    }

    // Orchestrator: 在 prompt 前拼接系统指令
    let finalPrompt = prompt;
    if (isOrchestrator) {
      const orchestratorPreamble =
        "你是一个 orchestrator（编排者），负责协调和管理多个 Claude Code 实例来完成复杂任务。\n" +
        "你可以使用 instance-manager MCP tools 来管理实例：\n" +
        "- list_instances: 查看所有实例的状态\n" +
        "- get_instance: 获取某个实例的详情\n" +
        "- create_instance: 创建新的子实例来执行子任务\n" +
        "- send_message: 向某个实例发送消息/指令\n" +
        "- stop_instance: 停止某个实例\n" +
        "- get_output: 读取某个实例的终端输出\n\n" +
        "工作原则：\n" +
        "1. 将复杂任务拆分为独立的子任务，为每个子任务创建单独的实例\n" +
        "2. 定期检查子实例的状态和输出，确保任务按计划推进\n" +
        "3. 当子实例需要决策时（等待输入），及时介入处理\n" +
        "4. 所有子任务完成后，汇总结果并报告\n\n" +
        "用户的目标：\n" + prompt;
      finalPrompt = orchestratorPreamble;
    }

    const instance = {
      id, label: label || id, prompt: finalPrompt,
      cwd: resolvedCwd,
      cliType: type,
      cliArgs: Array.isArray(cliArgs) ? cliArgs : [],
      role: isOrchestrator ? "orchestrator" : "worker",
      category: "agent",
      status: "running",
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      waitingInput: false,
      waitingInputSince: null,
      lastOutputAt: new Date().toISOString(),
      uploadedFiles: [],
      taskQueue: [],
      autoSendQueue: false,
      gitBranch: null,
      worktree: null,
      _mcpConfigPath: mcpConfigPath,
    };

    // Git branch 检测（所有实例通用）
    try {
      const gitInfo = await getGitInfo(instance.cwd);
      if (gitInfo.isGitRepo) instance.gitBranch = gitInfo.currentBranch;
    } catch (_) {}

    // Worktree 创建
    if (worktree && worktree.enabled) {
      const repoPath = instance.cwd;
      const sanitizedId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const branchName = worktree.branch || ("wt/" + sanitizedId);
      const worktreePath = path.join(repoPath, ".worktrees", sanitizedId);
      try {
        await createWorktree(repoPath, worktreePath, branchName);
        instance.cwd = worktreePath;
        instance.worktree = {
          enabled: true,
          repoPath,
          worktreePath,
          branch: branchName,
          baseBranch: worktree.baseBranch || instance.gitBranch || "main",
        };
        instance.gitBranch = branchName;
        console.log("[worktree] 创建成功: " + worktreePath + " (" + branchName + ")");
      } catch (err) {
        console.error("[worktree] 创建失败:", err.message);
      }
    }

    // Orchestrator: 注入 --mcp-config 到 CLI 参数
    if (mcpConfigPath) {
      instance.cliArgs = ["--mcp-config", mcpConfigPath, ...instance.cliArgs];
    }

    this.instances.set(id, instance);
    saveRecentDir(instance.cwd);
    this.broadcastAll({ type: "instance_created", instance: this._serialize(instance) });
    const cliPath = CLI_PATHS[type];
    if (pty && cliPath) {
      this._runPty(id, finalPrompt, instance.cwd, cliPath);
    } else if (!cliPath) {
      instance.status = "error";
      instance.finishedAt = new Date().toISOString();
      const errMsg = CLI_CONFIGS[type].label + " 未安装或不可用\n";
      instance.output = errMsg;
      this.broadcast(id, { type: "pty_data", data: errMsg });
      this.broadcast(id, { type: "status_change", status: "error" });
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(instance) });
    } else {
      this._runMock(id, prompt);
    }
    return this._serialize(instance);
  }

  _runPty(id, prompt, cwd, cliPath) {
    const inst = this.instances.get(id);
    console.log("[PTY] 启动实例 " + id + " (" + inst.cliType + ")");
    console.log("[PTY] 命令: " + cliPath + " prompt=" + JSON.stringify(prompt));
    console.log("[PTY] 工作目录: " + cwd);

    const args = [...(inst.cliArgs || [])];
    if (prompt) args.push(prompt);
    let ptyProc;
    try {
      ptyProc = pty.spawn(cliPath, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd,
        env: Object.assign({}, process.env, {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          PATH: (process.env.PATH || "") + ":/opt/homebrew/bin:/usr/local/bin",
        }),
      });
      console.log("[PTY] 进程已启动，PID: " + ptyProc.pid);
    } catch (err) {
      console.error("[PTY] spawn 失败:", err.message);
      inst.status = "error";
      inst.finishedAt = new Date().toISOString();
      const errMsg = "PTY 启动失败: " + err.message + "\n";
      inst.output = errMsg;
      this.broadcast(id, { type: "pty_data", data: errMsg });
      this.broadcast(id, { type: "status_change", status: "error" });
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
      return;
    }

    this.ptys.set(id, ptyProc);

    ptyProc.onData(data => {
      if (!this.instances.has(id)) return;
      inst.output += data;
      inst.lastOutputAt = new Date().toISOString();

      // (y/n) 类提示立即检测，无需等待静默期
      if (data.includes("(y/n)") || data.includes("(Y/n)") || data.includes("(Y/N)")) {
        if (!inst.waitingInput) {
          inst.waitingInput = true;
          inst.waitingInputSince = new Date().toISOString();
          this.broadcast(id, { type: "waiting_input", waiting: true });
          this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
          if (inst.autoSendQueue) {
            this._sendNextTask(id);
          }
        }
      }

      // 静默期检测：输出停止 1.5 秒后，检查累积输出末尾是否为提示符
      if (inst._quietTimer) clearTimeout(inst._quietTimer);
      inst._quietTimer = setTimeout(() => {
        if (!this.instances.has(id)) return;
        // 取最近 500 字符，完整去除 ANSI 序列后检测
        const tail = inst.output.slice(-500)
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/\x1b\][^\x07]*\x07/g, "")
          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        const lastChar = tail.trimEnd().slice(-1);
        const isPrompt = lastChar === "\u276f";
        // 检查 ❯ 前面是否有 Claude Code 的活跃状态行（含时间+token计数，如 "(2m 35s · ↓ 739 tokens)"）
        const isWorking = isPrompt && /\(\d+[hms]\s*\d*[hms]*\s*\xb7/.test(tail);
        if (isPrompt && !isWorking && !inst.waitingInput) {
          inst.waitingInput = true;
          inst.waitingInputSince = new Date().toISOString();
          this.broadcast(id, { type: "waiting_input", waiting: true });
          this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
          if (inst.autoSendQueue) {
            this._sendNextTask(id);
          }
        } else if ((!isPrompt || isWorking) && inst.waitingInput) {
          inst.waitingInput = false; inst.waitingInputSince = null;
          this.broadcast(id, { type: "waiting_input", waiting: false });
          this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
        }
      }, 1500);

      this.broadcast(id, { type: "pty_data", data });
    });

    ptyProc.onExit(({ exitCode }) => {
      if (!this.instances.has(id)) return;
      console.log("[PTY] 实例 " + id + " 退出，exit code: " + exitCode);
      inst.status = exitCode === 0 ? "done" : "error";
      inst.finishedAt = new Date().toISOString();
      inst.waitingInput = false; inst.waitingInputSince = null;
      // 清理 orchestrator MCP 配置临时文件
      if (inst._mcpConfigPath) {
        try { fs.unlinkSync(inst._mcpConfigPath); } catch (_) {}
      }
      this.ptys.delete(id);
      this.broadcast(id, { type: "status_change", status: inst.status });
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
    });
  }

  sendInput(id, text) {
    const ptyProc = this.ptys.get(id);
    if (!ptyProc) throw new Error("实例 " + id + " 无活跃 PTY");
    ptyProc.write(text);
  }

  async _runMock(id, prompt) {
    const inst = this.instances.get(id);
    const lines = [
      "\r\n[Mock] 会话已启动\r\n",
      "[Mock] 任务: " + prompt + "\r\n",
      "\r\n正在读取文件...\r\n",
      "分析完成，生成解决方案中...\r\n",
      "\r\n任务完成！\r\n",
      "\r\n是否继续？(y/n) ",
    ];
    for (let i = 0; i < lines.length; i++) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 400));
      if (!this.instances.has(id)) return;
      inst.output += lines[i];
      this.broadcast(id, { type: "pty_data", data: lines[i] });
      if (i === lines.length - 1) {
        inst.waitingInput = true;
        this.broadcast(id, { type: "waiting_input", waiting: true });
        this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
        await new Promise(r => setTimeout(r, 3000));
        if (!this.instances.has(id)) return;
        inst.waitingInput = false; inst.waitingInputSince = null;
        const reply = "y\r\n\r\n完成。\r\n";
        inst.output += reply;
        this.broadcast(id, { type: "pty_data", data: reply });
        this.broadcast(id, { type: "waiting_input", waiting: false });
      }
    }
    await new Promise(r => setTimeout(r, 600));
    if (!this.instances.has(id)) return;
    inst.status = "done";
    inst.finishedAt = new Date().toISOString();
    inst.waitingInput = false;
    this.broadcast(id, { type: "status_change", status: "done" });
    this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
  }

  stopInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error("实例 " + id + " 不存在");
    if (inst.status !== "running") throw new Error("实例 " + id + " 未在运行中");
    const ptyProc = this.ptys.get(id);
    if (ptyProc) { ptyProc.kill(); this.ptys.delete(id); }
    inst.status = "stopped";
    inst.finishedAt = new Date().toISOString();
    this.broadcast(id, { type: "status_change", status: "stopped" });
    this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
  }

  // ─── 终端实例 ──────────────────────────────────────────────────────────────
  startTerminalInstance({ id, cmd, cwd, label, port }) {
    if (this.instances.has(id)) throw new Error("实例 " + id + " 已存在");
    const cmdConfig = ALLOWED_SHELL_CMDS[cmd];
    if (!cmdConfig) throw new Error("不允许的命令: " + cmd);
    if (!NPM_PATH) throw new Error("npm 未安装或不可用");
    if (!pty) throw new Error("node-pty 不可用");
    const resolvedCwd = resolveManagedPath(cwd || "", DESKTOP);
    const cwdStat = fs.statSync(resolvedCwd);
    if (!cwdStat.isDirectory()) throw new Error("工作目录不存在");
    const normalizedPort = port ? String(port).trim() : "";
    if (normalizedPort && !/^\d{2,5}$/.test(normalizedPort)) {
      throw new Error("端口格式无效");
    }

    const instance = {
      id, label: label || cmdConfig.label,
      prompt: "",
      cwd: resolvedCwd,
      cliType: "shell",
      cliArgs: [],
      role: "terminal",
      category: "terminal",
      shellCmd: cmd,
      shellPort: normalizedPort,
      status: "running",
      output: "",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      waitingInput: false,
      waitingInputSince: null,
      lastOutputAt: new Date().toISOString(),
      uploadedFiles: [],
      taskQueue: [],
      autoSendQueue: false,
      gitBranch: null,
      worktree: null,
      _mcpConfigPath: null,
    };

    this.instances.set(id, instance);
    saveRecentDir(instance.cwd);
    this.broadcastAll({ type: "instance_created", instance: this._serialize(instance) });
    this._runShellPty(id);
    return this._serialize(instance);
  }

  _runShellPty(id) {
    const inst = this.instances.get(id);
    const cmdConfig = ALLOWED_SHELL_CMDS[inst.shellCmd];
    if (!cmdConfig) return;

    const args = [...cmdConfig.args];
    const env = Object.assign({}, process.env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: (process.env.PATH || "") + ":/opt/homebrew/bin:/usr/local/bin",
    });
    if (inst.shellPort) {
      env.PORT = inst.shellPort;
      // 通过 -- --port 传递给底层工具（Vite、Next.js 等）
      args.push("--", "--port", inst.shellPort);
    }

    console.log("[Shell] 启动终端实例 " + id + ": " + NPM_PATH + " " + args.join(" "));
    console.log("[Shell] 工作目录: " + inst.cwd + (inst.shellPort ? " PORT=" + inst.shellPort : ""));

    let ptyProc;
    try {
      ptyProc = pty.spawn(NPM_PATH, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: inst.cwd,
        env,
      });
      console.log("[Shell] 进程已启动，PID: " + ptyProc.pid);
    } catch (err) {
      console.error("[Shell] spawn 失败:", err.message);
      inst.status = "error";
      inst.finishedAt = new Date().toISOString();
      const errMsg = "终端启动失败: " + err.message + "\n";
      inst.output += errMsg;
      this.broadcast(id, { type: "pty_data", data: errMsg });
      this.broadcast(id, { type: "status_change", status: "error" });
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
      return;
    }

    this.ptys.set(id, ptyProc);

    ptyProc.onData(data => {
      if (!this.instances.has(id)) return;
      inst.output += data;
      inst.lastOutputAt = new Date().toISOString();
      this.broadcast(id, { type: "pty_data", data });
    });

    ptyProc.onExit(({ exitCode }) => {
      if (!this.instances.has(id)) return;
      console.log("[Shell] 实例 " + id + " 退出，exit code: " + exitCode);
      inst.status = exitCode === 0 ? "done" : "error";
      inst.finishedAt = new Date().toISOString();
      this.ptys.delete(id);
      this.broadcast(id, { type: "status_change", status: inst.status });
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
    });
  }

  restartInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error("实例 " + id + " 不存在");
    if (inst.category !== "terminal") throw new Error("只有终端实例支持重启");
    // 停止旧进程
    const ptyProc = this.ptys.get(id);
    if (ptyProc) { ptyProc.kill(); this.ptys.delete(id); }
    // 重置状态
    inst.status = "running";
    inst.output += "\n\r--- RESTART ---\n\r";
    inst.finishedAt = null;
    inst.startedAt = new Date().toISOString();
    inst.lastOutputAt = new Date().toISOString();
    this.broadcast(id, { type: "pty_data", data: "\n\r--- RESTART ---\n\r" });
    this.broadcast(id, { type: "status_change", status: "running" });
    this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
    // 重新启动
    this._runShellPty(id);
  }

  deleteInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error("实例 " + id + " 不存在");
    if (inst.status === "running") {
      const ptyProc = this.ptys.get(id);
      if (ptyProc) { ptyProc.kill(); this.ptys.delete(id); }
    }
    // 清理该实例上传的截图文件
    if (inst.uploadedFiles) {
      for (const filePath of inst.uploadedFiles) {
        try { fs.unlinkSync(filePath); console.log("[cleanup] 已删除: " + filePath); }
        catch (e) { console.warn("[cleanup] 删除失败: " + filePath + " - " + e.message); }
      }
    }
    this.instances.delete(id);
    this.broadcastAll({ type: "instance_deleted", instanceId: id });
  }

  _sendNextTask(id) {
    const inst = this.instances.get(id);
    if (!inst || !inst.autoSendQueue) return;
    const next = inst.taskQueue.find(t => t.status === "pending");
    if (!next) {
      inst.autoSendQueue = false;
      this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
      return;
    }
    this._sendTask(id, next.id);
  }

  _sendTask(id, taskId) {
    const inst = this.instances.get(id);
    if (!inst) return;
    const task = inst.taskQueue.find(t => t.id === taskId);
    if (!task || task.status === "sent") return;
    const ptyProc = this.ptys.get(id);
    if (!ptyProc) return;

    task.status = "sending";
    let msg = task.text;
    if (task.imageFile) {
      msg += "\n\n（附件截图已保存到工作目录，文件名: " + task.imageName + "，请查看截图内容并据此执行任务）";
    }
    ptyProc.write(msg + "\r");
    task.status = "sent";
    inst.waitingInput = false;
    // 设置冷却期：发送后 3 秒内忽略 waitingInput 变化，避免中间输出误触发
    inst._waitingCooldownUntil = Date.now() + 3000;
    this.broadcast(id, { type: "waiting_input", waiting: false });
    this.broadcast(id, { type: "task_queue_updated", tasks: inst.taskQueue });
    this.broadcastAll({ type: "instance_updated", instance: this._serialize(inst) });
  }

  listInstances() { return [...this.instances.values()].map(i => this._serialize(i)); }
  getInstance(id)  { const i = this.instances.get(id); return i ? this._serialize(i) : null; }
  _serialize(inst) {
    const { output, uploadedFiles, taskQueue, _quietTimer, _waitingCooldownUntil, _mcpConfigPath, ...rest } = inst;
    const clean = stripAnsi(output);
    const lastOutput = clean.length > 200 ? clean.slice(-200) : clean;
    return { ...rest, taskQueueLen: (taskQueue || []).length, outputLen: output.length, lastOutput };
  }
  getOutput(id)    { const inst = this.instances.get(id); return inst ? inst.output : undefined; }
}

const app     = express();
const server  = http.createServer(app);
const wss     = new WebSocket.Server({ server });
const manager = new InstanceManager();

function closeUnauthorizedSockets(reason) {
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!getSessionByToken(ws._sessionToken)) {
      try { ws.close(4001, reason || "会话已失效"); } catch (_) {}
    }
  });
}

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
app.use(originMiddleware);
app.use(authMiddleware);
app.use(express.static(path.join(__dirname)));

// ─── 认证 API ─────────────────────────────────────────────────────────────────
app.post("/api/login", loginRateLimiter, (req, res) => {
  const { password } = req.body;
  if (!verifyPassword(password, AUTH_HASH, AUTH_SALT)) {
    return res.status(403).json({ error: "密码错误" });
  }
  const token = createSession();
  setSessionCookie(req, res, token);
  res.json({ ok: true, passwordIsAuto: AUTH_PASSWORD_IS_AUTO });
});

app.get("/api/auth-check", (req, res) => {
  const authenticated = isAuthenticated(req);
  res.json({ authenticated, passwordIsAuto: AUTH_PASSWORD_IS_AUTO, sessionTtlMs: SESSION_TTL_MS });
});

app.post("/api/logout", (req, res) => {
  revokeSession(getSessionToken(req));
  closeUnauthorizedSockets("会话已退出");
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.put("/api/change-password", passwordRateLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || String(newPassword).trim().length < 8) {
    return res.status(400).json({ error: "新密码至少需要 8 个字符" });
  }
  if (!AUTH_PASSWORD_IS_AUTO && !verifyPassword(currentPassword, AUTH_HASH, AUTH_SALT)) {
    return res.status(403).json({ error: "当前密码错误" });
  }
  try {
    ({ hash: AUTH_HASH, salt: AUTH_SALT } = saveAuthSettings(String(newPassword).trim()));
  } catch (e) {
    return res.status(500).json({ error: "保存失败: " + e.message });
  }
  AUTH_PASSWORD_IS_AUTO = false;
  sessions.clear();
  const token = createSession();
  closeUnauthorizedSockets("密码已更新");
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.get("/api/browse", (req, res) => {
  try {
    const reqPath = resolveManagedPath(req.query.path || "", DESKTOP);
    const entries = fs.readdirSync(reqPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({ name: e.name, path: path.join(reqPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rawParent = path.dirname(reqPath) !== reqPath ? path.dirname(reqPath) : null;
    const parent = rawParent && isAllowedPath(rawParent) ? rawParent : null;
    res.json({ current: reqPath, parent, dirs });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── 最近目录 API ───────────────────────────────────────────────────────────
app.get("/api/recent-dirs", (req, res) => {
  try {
    const managerDirs = loadRecentDirs();
    const claudeDirs = scanClaudeProjectDirs();
    // 合并：manager 记录优先（有 count），claude 记录补充
    const seen = new Set();
    const merged = [];
    for (const d of managerDirs) {
      if (!seen.has(d.path)) { seen.add(d.path); merged.push(d); }
    }
    for (const d of claudeDirs) {
      if (!seen.has(d.path)) { seen.add(d.path); merged.push(d); }
    }
    // 过滤掉不存在的目录和过于通用的路径（根目录、home 目录等）
    const home = process.env.HOME || "";
    const tooGeneric = new Set(["/", home, home + "/Desktop", home + "/Documents", home + "/Downloads"]);
    const valid = merged.filter(d => {
      if (tooGeneric.has(d.path)) return false;
      if (!isAllowedPath(d.path)) return false;
      try { return fs.statSync(d.path).isDirectory(); } catch (_) { return false; }
    });
    valid.sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));
    res.json(valid.slice(0, RECENT_DIRS_MAX));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── 图片上传 API（multer）────────────────────────────────────────────────────
const IMAGE_SIGNATURES = [
  {
    mime: "image/png",
    ext: ".png",
    matches: (buf) => buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    ext: ".jpg",
    matches: (buf) => buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: ".gif",
    matches: (buf) => buf.length >= 6 && (
      buf.slice(0, 6).toString("ascii") === "GIF87a" ||
      buf.slice(0, 6).toString("ascii") === "GIF89a"
    ),
  },
  {
    mime: "image/webp",
    ext: ".webp",
    matches: (buf) => buf.length >= 12 &&
      buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP",
  },
];

function detectImageInfo(buffer) {
  return IMAGE_SIGNATURES.find(item => item.matches(buffer)) || null;
}

function sanitizeImageBasename(originalName) {
  const base = path.basename(String(originalName || "image"), path.extname(String(originalName || "")));
  return base.replace(/[^a-zA-Z0-9_-]/g, "_") || "image";
}

function saveValidatedImage(targetDir, file) {
  const resolvedDir = resolveManagedPath(targetDir, DESKTOP);
  const stat = fs.statSync(resolvedDir);
  if (!stat.isDirectory()) throw new Error("目标目录不存在");
  const imageInfo = detectImageInfo(file.buffer);
  if (!imageInfo) throw new Error("图片格式无效，仅支持 PNG/JPEG/GIF/WEBP");
  const filename = sanitizeImageBasename(file.originalname) + "_" + Date.now() + imageInfo.ext;
  const savePath = path.join(resolvedDir, filename);
  fs.writeFileSync(savePath, file.buffer);
  return { filename, savePath, mime: imageInfo.mime };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("只支持图片文件"));
  },
});

app.post("/api/upload-image", upload.single("image"), (req, res) => {
  try {
    const instanceId = req.body.instanceId;
    if (!req.file)   return res.status(400).json({ error: "未收到图片" });
    if (!instanceId) return res.status(400).json({ error: "缺少 instanceId" });

    const inst = manager.instances.get(instanceId);
    if (!inst) return res.status(404).json({ error: "实例不存在" });

    const { filename, savePath } = saveValidatedImage(inst.cwd, req.file);
    inst.uploadedFiles.push(savePath);
    console.log("[upload] 图片已保存: " + savePath);

    res.json({ ok: true, filename, path: savePath });
  } catch (err) {
    console.error("[upload] 错误:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Tunnel API ──────────────────────────────────────────────────────────────
app.get("/api/tunnel-status", (req, res) => {
  res.json({
    available: tunnelState.available,
    enabled: tunnelState.enabled,
    status: tunnelState.status,
    url: tunnelState.url,
  });
});

app.post("/api/tunnel-toggle", (req, res) => {
  if (!tunnelState.available) {
    return res.status(400).json({ error: "cloudflared 未安装，无法启用隧道" });
  }
  const { enabled } = req.body;
  if (enabled && !tunnelState.enabled) {
    tunnelState.enabled = true;
    startTunnel();
    console.log("[tunnel] 用户开启隧道");
    res.json({ ok: true, status: "connecting" });
  } else if (!enabled && tunnelState.enabled) {
    tunnelState.enabled = false;
    stopTunnel();
    console.log("[tunnel] 用户关闭隧道");
    res.json({ ok: true, status: "idle" });
  } else {
    res.json({ ok: true, status: tunnelState.status });
  }
});

app.get("/api/instances",     (req, res) => res.json(manager.listInstances()));
app.get("/api/instances/:id", (req, res) => {
  const i = manager.getInstance(req.params.id);
  i ? res.json(i) : res.status(404).json({ error: "实例不存在" });
});
app.get("/api/instances/:id/output", (req, res) => {
  const raw = manager.getOutput(req.params.id);
  if (raw === undefined) return res.status(404).json({ error: "实例不存在" });
  const clean = stripAnsi(raw);
  const tail = parseInt(req.query.tail, 10) || 50;
  const lines = clean.split("\n");
  const output = lines.slice(-tail).join("\n");
  res.json({ output, totalLines: lines.length });
});
// CLI 可用状态
app.get("/api/cli-status", (req, res) => {
  const status = {};
  for (const [key, cfg] of Object.entries(CLI_CONFIGS)) {
    status[key] = { available: !!CLI_PATHS[key], label: cfg.label };
  }
  res.json(status);
});

app.get("/api/git-info", async (req, res) => {
  const dirPath = req.query.path;
  if (!dirPath) return res.status(400).json({ error: "缺少 path 参数" });
  try {
    const info = await getGitInfo(resolveManagedPath(dirPath, DESKTOP));
    res.json(info);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── 最近会话 API（读取 Claude Code 本地会话记录）────────────────────────────
app.get("/api/recent-sessions", async (req, res) => {
  const cwd = req.query.cwd || "";
  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  try {
    let files = [];
    if (cwd) {
      // 指定目录：只扫描该项目目录
      const normalizedCwd = resolveManagedPath(cwd, DESKTOP);
      const projectDirName = normalizedCwd.replace(/\//g, "-").replace(/[^\x21-\x7E]/g, "-");
      const sessionDir = path.join(claudeProjectsDir, projectDirName);
      if (!fs.existsSync(sessionDir)) {
        return res.json([]);
      }
      files = fs.readdirSync(sessionDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => {
          const fullPath = path.join(sessionDir, f);
          const stat = fs.statSync(fullPath);
          return { file: f, path: fullPath, mtime: stat.mtimeMs, projectDir: sessionDir, projectName: projectDirName };
        });
    } else {
      // 未指定目录：扫描所有项目目录，汇总最近会话
      if (!fs.existsSync(claudeProjectsDir)) return res.json([]);
      const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== "memory");
      for (const pd of projectDirs) {
        const sessionDir = path.join(claudeProjectsDir, pd.name);
        try {
          const jsonlFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          for (const f of jsonlFiles) {
            const fullPath = path.join(sessionDir, f);
            try {
              const stat = fs.statSync(fullPath);
              files.push({ file: f, path: fullPath, mtime: stat.mtimeMs, projectDir: sessionDir, projectName: pd.name });
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
    files = files.sort((a, b) => b.mtime - a.mtime).slice(0, 20);

    const sessions = [];
    for (const { file, path: filePath, mtime, projectName } of files) {
      const sessionId = file.replace(".jsonl", "");
      let firstUserMessage = "";
      let sessionName = "";
      let lastTimestamp = "";
      let sessionCwd = "";
      try {
        // 只读取前 256KB 来找首条用户消息（图片消息的 base64 会很长）
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(262144);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const headContent = buf.slice(0, bytesRead).toString("utf-8");
        const lines = headContent.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.sessionName && !sessionName) {
              sessionName = obj.sessionName;
            }
            if (obj.cwd && !sessionCwd) {
              sessionCwd = obj.cwd;
            }
            // 查找第一条用��消息
            if (obj.type === "user" && !firstUserMessage) {
              const msg = obj.message;
              if (msg && msg.content) {
                if (typeof msg.content === "string") {
                  firstUserMessage = msg.content.slice(0, 120);
                } else if (Array.isArray(msg.content)) {
                  const textPart = msg.content.find(p => p.type === "text");
                  if (textPart) firstUserMessage = textPart.text.slice(0, 120);
                  else firstUserMessage = "[包含图片/附件]";
                }
              }
              break;
            }
          } catch (_) {}
        }
        lastTimestamp = new Date(mtime).toISOString();
      } catch (_) {}
      sessions.push({
        sessionId,
        name: sessionName,
        firstMessage: firstUserMessage || "(无消息)",
        lastModified: new Date(mtime).toISOString(),
        lastTimestamp: lastTimestamp || new Date(mtime).toISOString(),
        cwd: sessionCwd,
        projectName: projectName || "",
      });
    }
    res.json(sessions.filter(session => !session.cwd || isAllowedPath(session.cwd)));
  } catch (err) {
    res.status(500).json({ error: "读取会话记录失败: " + err.message });
  }
});

app.post("/api/instances", upload.single("image"), async (req, res) => {
  const { id, cwd, label, cliType, role } = req.body;
  const prompt = req.body.prompt || "";
  let cliArgs = req.body.cliArgs || [];
  if (typeof cliArgs === "string") {
    try { cliArgs = JSON.parse(cliArgs); } catch (_) { cliArgs = []; }
  }
  if (!Array.isArray(cliArgs)) cliArgs = [];
  // 过滤：只允许字符串，防止注入
  cliArgs = cliArgs.filter(a => typeof a === "string").map(a => String(a));
  console.log("[create] body:", JSON.stringify({ id, cwd, label, cliType, prompt: prompt.slice(0, 50), cliArgs }));

  let targetCwd;
  try {
    targetCwd = resolveManagedPath(cwd || "", DESKTOP);
    if (!fs.statSync(targetCwd).isDirectory()) throw new Error("工作目录不存在");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let finalPrompt = prompt;
  let preUploadedPath = null;

  // 如果有附件图片，先保存到工作目录
  if (req.file) {
    try {
      const saved = saveValidatedImage(targetCwd, req.file);
      preUploadedPath = saved.savePath;
      finalPrompt = prompt + "\n\n（附件截图已保存到工作目录，文件名: " + saved.filename + "，请查看截图内容并据此执行任务）";
      console.log("[upload] 实例创建附件: " + saved.savePath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    const worktreeEnabled = req.body.worktreeEnabled === "true" || req.body.worktreeEnabled === true;
    const worktreeOpts = worktreeEnabled ? {
      enabled: true,
      baseBranch: req.body.baseBranch || "",
      branch: req.body.worktreeBranch || "",
    } : null;
    const inst = await manager.startInstance({ id: id || ("inst-" + Date.now()), prompt: finalPrompt, cwd: targetCwd, label, cliType, worktree: worktreeOpts, cliArgs, role });
    if (preUploadedPath) {
      const instance = manager.instances.get(inst.id);
      if (instance) instance.uploadedFiles.push(preUploadedPath);
    }
    res.status(201).json(inst);
  } catch (err) {
    if (preUploadedPath) {
      try { fs.unlinkSync(preUploadedPath); } catch (_) {}
    }
    res.status(400).json({ error: err.message });
  }
});
// ─── 终端实例创建 ──────────────────────────────────────────────────────────────
app.post("/api/terminal-instances", (req, res) => {
  const { id, cmd, cwd, label, port } = req.body;
  if (!cmd) return res.status(400).json({ error: "缺少 cmd 参数" });
  if (!ALLOWED_SHELL_CMDS[cmd]) {
    return res.status(400).json({ error: "不允许的命令: " + cmd + "。允许的命令: " + Object.keys(ALLOWED_SHELL_CMDS).join(", ") });
  }
  try {
    const inst = manager.startTerminalInstance({
      id: id || ("term-" + Date.now()),
      cmd, cwd: cwd || DESKTOP, label, port,
    });
    res.status(201).json(inst);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/instances/:id/restart", (req, res) => {
  try { manager.restartInstance(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/instances/:id/stop", (req, res) => {
  try { manager.stopInstance(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete("/api/instances/:id", (req, res) => {
  try { manager.deleteInstance(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// 重命名实例
app.patch("/api/instances/:id", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  const { label } = req.body;
  if (typeof label === "string") {
    inst.label = label.trim() || inst.id;
    manager.broadcastAll({ type: "instance_updated", instance: manager._serialize(inst) });
  }
  res.json({ ok: true });
});

// ─── Git Worktree API ────────────────────────────────────────────────────────
app.post("/api/instances/:id/cleanup-worktree", async (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!inst.worktree || !inst.worktree.enabled) {
    return res.status(400).json({ error: "该实例未使用 worktree" });
  }
  const { action } = req.body;
  try {
    if (action === "remove-worktree" || action === "remove-all") {
      await removeWorktree(inst.worktree.repoPath, inst.worktree.worktreePath);
      console.log("[worktree] 已移除: " + inst.worktree.worktreePath);
    }
    if (action === "remove-all") {
      await deleteBranch(inst.worktree.repoPath, inst.worktree.branch);
      console.log("[worktree] 已删除分支: " + inst.worktree.branch);
    }
    const msgs = { keep: "已保留 worktree 和分支", "remove-worktree": "已移除 worktree，保留分支", "remove-all": "已移除 worktree 和分支" };
    res.json({ ok: true, message: msgs[action] || "完成" });
  } catch (err) { res.status(500).json({ error: "清理 worktree 失败: " + err.message }); }
});

app.post("/api/instances/:id/git-merge", async (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!inst.worktree || !inst.worktree.enabled) {
    return res.status(400).json({ error: "该实例未使用 worktree" });
  }
  try {
    const result = await mergeWorktreeBranch(inst.worktree.repoPath, inst.worktree.branch, inst.worktree.baseBranch);
    res.json(result);
  } catch (err) { res.status(500).json({ error: "合并失败: " + err.message }); }
});

app.post("/api/instances/:id/git-push", async (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!inst.worktree || !inst.worktree.enabled) {
    return res.status(400).json({ error: "该实例未使用 worktree" });
  }
  const remote = req.body.remote || "origin";
  try {
    const result = await pushBranch(inst.worktree.repoPath, inst.worktree.branch, remote);
    res.json(result);
  } catch (err) { res.status(500).json({ error: "推送失败: " + err.message }); }
});

// ─── 任务队列 API ─────────────────────────────────────────────────────────────
app.get("/api/instances/:id/tasks", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  res.json(inst.taskQueue || []);
});

app.post("/api/instances/:id/tasks", upload.single("image"), (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });

  const text = (req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "任务内容不能为空" });

  const position = req.body.position !== undefined ? parseInt(req.body.position, 10) : -1;
  const task = {
    id: "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    text,
    imageFile: null,
    imageName: null,
    status: "pending",
  };

  // 处理图片附件
  if (req.file) {
    try {
      const saved = saveValidatedImage(inst.cwd, req.file);
      task.imageFile = saved.savePath;
      task.imageName = saved.filename;
      inst.uploadedFiles.push(saved.savePath);
      console.log("[task-queue] 任务图片已保存: " + saved.savePath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (position >= 0 && position < inst.taskQueue.length) {
    inst.taskQueue.splice(position, 0, task);
  } else {
    inst.taskQueue.push(task);
  }

  manager.broadcast(req.params.id, { type: "task_queue_updated", tasks: inst.taskQueue });
  res.status(201).json(task);
});

app.delete("/api/instances/:id/tasks/:taskId", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });

  const idx = inst.taskQueue.findIndex(t => t.id === req.params.taskId);
  if (idx === -1) return res.status(404).json({ error: "任务不存在" });

  inst.taskQueue.splice(idx, 1);
  manager.broadcast(req.params.id, { type: "task_queue_updated", tasks: inst.taskQueue });
  res.json({ ok: true });
});

app.put("/api/instances/:id/tasks/:taskId", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  const task = inst.taskQueue.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status !== "pending") return res.status(400).json({ error: "已发送的任务不可编辑" });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "任务内容不能为空" });
  task.text = text.trim();
  manager.broadcast(req.params.id, { type: "task_queue_updated", tasks: inst.taskQueue });
  res.json({ ok: true });
});

app.post("/api/instances/:id/tasks/:taskId/send", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!manager.ptys.get(req.params.id)) return res.status(400).json({ error: "实例无活跃 PTY" });

  const task = inst.taskQueue.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.status === "sent") return res.status(400).json({ error: "任务已发送" });

  manager._sendTask(req.params.id, req.params.taskId);
  res.json({ ok: true });
});

app.post("/api/instances/:id/tasks/send-all", (req, res) => {
  const inst = manager.instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!manager.ptys.get(req.params.id)) return res.status(400).json({ error: "实例无活跃 PTY" });

  const pending = inst.taskQueue.filter(t => t.status === "pending");
  if (pending.length === 0) return res.status(400).json({ error: "没有待发送的任务" });

  inst.autoSendQueue = true;
  // 立即发送第一个任务
  manager._sendNextTask(req.params.id);
  res.json({ ok: true, pendingCount: pending.length });
});

// ─── AI 设置与解释 API ────────────────────────────────────────────────────────
app.get("/api/ai-settings", (req, res) => {
  const settings = loadAISettings();
  const masked = settings.apiKey ? "••••••••" + settings.apiKey.slice(-4) : "";
  res.json({ provider: settings.provider, model: settings.model, apiKey: masked, hasKey: !!settings.apiKey });
});

app.put("/api/ai-settings", (req, res) => {
  const { provider, apiKey, model } = req.body;
  const current = loadAISettings();
  const finalKey = (apiKey && !apiKey.startsWith("••••")) ? apiKey : current.apiKey;
  const saved = saveAISettings({ provider: provider || current.provider, apiKey: finalKey, model: model || "" });
  res.json({ ok: true, provider: saved.provider, model: saved.model, hasKey: !!saved.apiKey });
});

app.post("/api/ai-explain", async (req, res) => {
  const { instanceId } = req.body;
  if (!instanceId) return res.status(400).json({ error: "缺少 instanceId" });

  const inst = manager.instances.get(instanceId);
  if (!inst) return res.status(404).json({ error: "实例不存在" });

  const settings = loadAISettings();
  if (!settings.apiKey) {
    return res.status(400).json({ error: "未配置 AI API Key，请先在设置中配置" });
  }

  const context = extractRecentContext(inst.output);
  if (!context.trim()) {
    return res.status(400).json({ error: "终端暂无输出内容" });
  }

  const systemPrompt = "你是一个 Claude Code 终端助手。用户正在使用 Claude Code（Anthropic 的 AI 编程工具），终端中出现了一个需要用户决策的提示。\n\n请你：\n1. 解释当前 Claude Code 正在做什么操作\n2. 解释它为什么需要用户确认/决策\n3. 分析选择不同选项（如 y/n）的影响\n4. 给出你的建议\n\n请用中文回答，简洁明了。";
  const userPrompt = "以下是 Claude Code 终端的最近输出，请解释当前的决策提示：\n\n```\n" + context + "\n```";

  try {
    let explanation;
    if (settings.provider === "anthropic") {
      explanation = await callAnthropic(settings, systemPrompt, userPrompt);
    } else {
      explanation = await callOpenAI(settings, systemPrompt, userPrompt);
    }
    res.json({ ok: true, explanation });
  } catch (e) {
    console.error("[AI Explain] 错误:", e.message);
    res.status(500).json({ error: "AI 调用失败: " + e.message });
  }
});

wss.on("connection", (ws, req) => {
  if (!isAllowedOrigin(req)) {
    ws.close(4003, "请求来源不被允许");
    return;
  }
  const sessionToken = getSessionToken(req);
  if (!touchSession(sessionToken)) {
    ws.close(4001, "未授权");
    return;
  }
  ws._sessionToken = sessionToken;
  console.log("WebSocket 客户端连接（已认证）");
  manager.subscribe("__global__", ws);
  ws.send(JSON.stringify({ type: "init", instances: manager.listInstances() }));

  const sessionCheckTimer = setInterval(() => {
    if (!getSessionByToken(ws._sessionToken)) {
      try { ws.close(4001, "会话已过期"); } catch (_) {}
    }
  }, 60 * 1000);
  sessionCheckTimer.unref();

  ws.on("message", raw => {
    if (!touchSession(ws._sessionToken)) {
      ws.close(4001, "会话已过期");
      return;
    }
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "subscribe") {
        console.log("[ws] subscribe action for " + msg.instanceId);
        manager.subscribe(msg.instanceId, ws);
        // pty_replay 已在 manager.subscribe() 中发送，此处不再重复
      }
      if (msg.action === "unsubscribe") manager.unsubscribe(msg.instanceId, ws);
      if (msg.action === "pty_input") {
        try { manager.sendInput(msg.instanceId, msg.data); }
        catch (e) { ws.send(JSON.stringify({ type: "error", message: e.message })); }
      }
      if (msg.action === "pty_resize") {
        const ptyProc = manager.ptys.get(msg.instanceId);
        if (ptyProc) ptyProc.resize(msg.cols, msg.rows);
      }
    } catch (_) {}
  });

  ws.on("close", () => {
    clearInterval(sessionCheckTimer);
    manager.unsubscribe("__global__", ws);
    manager.instances.forEach((_, id) => manager.unsubscribe(id, ws));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, BIND_HOST, () => {
  console.log("AI CLI 多实例管理器启动成功");
  console.log("本机访问: http://localhost:" + PORT);
  if (isLoopbackHost(BIND_HOST)) {
    console.log("远程访问默认关闭；如需开启，请显式设置 HOST=0.0.0.0");
  } else if (BIND_HOST === "0.0.0.0") {
    const ips = getLocalIPs();
    if (ips.length > 0) {
      ips.forEach(ip => console.log("局域网访问: http://" + ip + ":" + PORT));
    }
  } else {
    console.log("监听地址: http://" + BIND_HOST + ":" + PORT);
  }
  if (process.env.AUTH_PASSWORD) {
    console.log("使用环境变量密码");
  } else if (_savedAuth) {
    console.log("使用已保存的密码");
  } else {
    console.log("自动生成密码: " + _autoGenPassword);
  }
  const availCLIs = Object.entries(CLI_PATHS)
    .filter(([, p]) => p)
    .map(([k, p]) => CLI_CONFIGS[k].label + " (" + p + ")");
  console.log("可用 CLI: " + (availCLIs.length ? availCLIs.join(", ") : "无 (Mock 模式)"));
  console.log("允许访问根目录: " + ALLOWED_ROOTS.join(", "));

  // 启动 Cloudflare Tunnel（可通过 TUNNEL=0 禁用）
  startTunnel(PORT);
});

// ─── 优雅退出：只 kill 本进程创建的 PTY 子进程 ──────────────────────────────
function gracefulShutdown(signal) {
  console.log("\n[shutdown] 收到 " + signal + "，正在释放所有 PTY 子进程...");
  stopTunnel();
  const ptys = manager.ptys;
  if (ptys.size === 0) {
    console.log("[shutdown] 无活跃子进程，直接退出");
    process.exit(0);
  }
  ptys.forEach((ptyProc, id) => {
    try {
      ptyProc.kill();
      console.log("[shutdown] 已终止实例 " + id + "（PID " + ptyProc.pid + "）");
    } catch (e) {
      console.warn("[shutdown] 终止实例 " + id + " 时出错: " + e.message);
    }
  });
  ptys.clear();
  console.log("[shutdown] 完成，退出");
  process.exit(0);
}

process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
