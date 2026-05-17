#!/usr/bin/env node
"use strict";

const { app, BrowserWindow, Menu, dialog, shell, nativeImage } = require("electron");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execSync, spawn } = require("child_process");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");

// ── Constants ──────────────────────────────────────────────────────────────
const PORT = 4188;
const CONFIG_DIR = path.resolve(os.homedir(), ".cc-connect");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml");
const STATE_PATH = path.join(CONFIG_DIR, "config-ui-state.json");
const isPackaged = typeof app === "object" && app !== null && app.isPackaged === true;
const ROOT = isPackaged ? path.join(process.resourcesPath, "app") : __dirname;
const SCRIPTS_DIR = isPackaged
  ? path.join(process.resourcesPath, "scripts")
  : path.join(__dirname, "scripts");

// ── Environment ────────────────────────────────────────────────────────────
process.env.CC_CONNECT_CONFIG_PATH = CONFIG_PATH;
process.env.CC_CONNECT_WORK_DIR = CONFIG_DIR;

// ── Helpers ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function jsonRes(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}
function sendError(res, code, msg) {
  jsonRes(res, code, { error: msg });
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return null; }
}

function daemonStatus() {
  try {
    const out = execSync("cc-connect daemon status --work-dir " + JSON.stringify(CONFIG_DIR), {
      encoding: "utf-8", timeout: 5000,
    });
    return out.toLowerCase().includes("running");
  } catch { return false; }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── HTTP Router ────────────────────────────────────────────────────────────
async function onRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // API routes (same as server.js)
  if (pathname === "/api/config") {
    if (method === "GET") {
      try {
        if (!fs.existsSync(CONFIG_PATH)) return jsonRes(res, 200, { config: {}, raw: "" });
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const config = parseToml(raw);
        return jsonRes(res, 200, { config, raw });
      } catch (e) { return sendError(res, 500, "Failed to read config: " + e.message); }
    }
    if (method === "PUT") {
      try {
        const body = await parseBody(req);
        if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".backup");
        const toml = stringifyToml(body.config);
        fs.writeFileSync(CONFIG_PATH, toml, "utf-8");
        return jsonRes(res, 200, { ok: true });
      } catch (e) { return sendError(res, 500, "Failed to write config: " + e.message); }
    }
    return sendError(res, 405);
  }

  if (pathname === "/api/restart" && method === "POST") {
    execFile("cc-connect", ["daemon", "restart", "--work-dir", CONFIG_DIR], { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) return jsonRes(res, 500, { error: "Restart failed", output: stderr || err.message });
        jsonRes(res, 200, { ok: true, output: stdout.trim() });
      });
    return;
  }

  if (pathname === "/api/info" && method === "GET") {
    const info = { configPath: CONFIG_PATH, statePath: STATE_PATH, daemonRunning: daemonStatus(), configExists: fs.existsSync(CONFIG_PATH) };
    if (info.configExists) {
      const stat = fs.statSync(CONFIG_PATH);
      info.configSize = stat.size;
      info.configModified = stat.mtime.toISOString();
    }
    // Add dep check info
    try {
      const depScript = path.join(SCRIPTS_DIR, "install-check.js");
      if (fs.existsSync(depScript)) {
        const depOut = execSync(`node "${depScript}" --json`, { encoding: "utf-8", timeout: 5000 });
        info.dependencies = JSON.parse(depOut);
      }
    } catch { /* skip */ }
    return jsonRes(res, 200, info);
  }

  if (pathname === "/api/state") {
    if (method === "GET") {
      const state = readJsonSafe(STATE_PATH) || { feishuAppTemplates: [], userGroupTemplates: [] };
      return jsonRes(res, 200, state);
    }
    if (method === "PUT") {
      try {
        const body = await parseBody(req);
        fs.writeFileSync(STATE_PATH, JSON.stringify(body, null, 2), "utf-8");
        return jsonRes(res, 200, { ok: true });
      } catch (e) { return sendError(res, 500, "Failed to write state: " + e.message); }
    }
    return sendError(res, 405);
  }

  if (pathname === "/api/deps-check" && method === "POST") {
    const fix = url.searchParams.has("fix");
    try {
      const depScript = path.join(SCRIPTS_DIR, "install-check.js");
      const child = spawn("node", [depScript, "--json", ...(fix ? ["--fix"] : [])]);
      let out = "";
      child.stdout.on("data", d => out += d);
      child.on("close", (code) => {
        try { return jsonRes(res, 200, { ...JSON.parse(out), exitCode: code }); }
        catch { return jsonRes(res, 200, { raw: out, exitCode: code }); }
      });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
    return;
  }

  if (pathname === "/api/setup-env" && method === "POST") {
    try {
      const setupScript = path.join(SCRIPTS_DIR, "setup-env.sh");
      if (fs.existsSync(setupScript)) {
        execFile("/bin/zsh", [setupScript, "--apply"], { timeout: 5000 },
          (err, stdout) => {
            if (err) return jsonRes(res, 500, { error: err.message });
            jsonRes(res, 200, { ok: true, output: stdout.trim() });
          });
      } else {
        jsonRes(res, 200, { ok: true, note: "setup script not found" });
      }
    } catch (e) {
      sendError(res, 500, e.message);
    }
    return;
  }

  // Static files
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(ROOT, filePath);
  if (!filePath.startsWith(ROOT)) return sendError(res, 403, "Forbidden");
  if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Setup wizard page
  if (pathname === "/setup") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(SETUP_HTML);
  }

  sendError(res, 404, "Not found");
}

// ── Setup Wizard HTML ──────────────────────────────────────────────────────
const SETUP_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>cc-connect 设置</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d12;color:#e2e2ef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#15151d;border:1px solid #2a2a3e;border-radius:12px;padding:40px;max-width:480px;width:90%}
h1{font-size:22px;margin-bottom:8px;color:#7c6ef0}
p{color:#9d9db5;font-size:14px;margin-bottom:24px;line-height:1.6}
.status{margin-bottom:20px}
.item{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:14px;border-bottom:1px solid #1c1c28}
.item:last-child{border:none}
.item .icon{width:20px;text-align:center}
.item .icon.ok{color:#3fb950}
.item .icon.fail{color:#e5534b}
.item .icon.pending{color:#d29922}
.item .label{flex:1}
.item .detail{color:#9d9db5;font-size:12px}
.btn{padding:10px 24px;border-radius:6px;border:none;font-size:14px;cursor:pointer;font-weight:500;transition:.15s}
.btn-primary{background:#7c6ef0;color:#fff;width:100%}
.btn-primary:hover{background:#9489f5}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.progress{height:4px;background:#1c1c28;border-radius:2px;margin:16px 0;overflow:hidden}
.progress-bar{height:100%;background:#7c6ef0;width:0%;transition:width .5s ease;border-radius:2px}
#statusText{font-size:13px;color:#9d9db5;text-align:center;margin-top:8px}
.hidden{display:none}
</style></head>
<body>
<div class="card">
  <h1>cc-connect Config</h1>
  <p>正在检查运行环境...</p>
  <div class="status" id="statusList">
    <div class="item"><span class="icon pending" id="i-node">⋯</span><span class="label">Node.js</span><span class="detail" id="d-node">检查中...</span></div>
    <div class="item"><span class="icon pending" id="i-npm">⋯</span><span class="label">npm</span><span class="detail" id="d-npm">检查中...</span></div>
    <div class="item"><span class="icon pending" id="i-cc">⋯</span><span class="label">cc-connect</span><span class="detail" id="d-cc">检查中...</span></div>
    <div class="item"><span class="icon pending" id="i-daemon">⋯</span><span class="label">守护进程</span><span class="detail" id="d-daemon">检查中...</span></div>
    <div class="item"><span class="icon pending" id="i-config">⋯</span><span class="label">配置文件</span><span class="detail" id="d-config">检查中...</span></div>
  </div>
  <div class="progress"><div class="progress-bar" id="progressBar"></div></div>
  <p id="statusText">正在检测...</p>
  <button class="btn btn-primary hidden" id="actionBtn" onclick="runAction()">继续</button>
  <div id="envOption" class="hidden" style="margin-top:16px">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#9d9db5">
      <input type="checkbox" id="setupEnv" checked> 将 CC_CONNECT_CONFIG_PATH 添加到 Shell 配置文件
    </label>
  </div>
</div>
<script>
const icons = { ok: '✓', fail: '✗', pending: '⋯' };

function setStatus(id, status, detail) {
  const el = document.getElementById(id);
  if (el) { el.textContent = icons[status] || '?'; el.className = 'icon ' + status; }
  const det = document.getElementById('d-' + id.replace('i-', ''));
  if (det && detail) det.textContent = detail;
}

function setProgress(pct) {
  document.getElementById('progressBar').style.width = pct + '%';
}

function showAction(text) {
  const btn = document.getElementById('actionBtn');
  btn.textContent = text;
  btn.classList.remove('hidden');
}

let actionType = '';

async function runAction() {
  if (actionType === 'install') {
    document.getElementById('actionBtn').disabled = true;
    document.getElementById('actionBtn').textContent = '安装中...';
    setProgress(30);
    document.getElementById('statusText').textContent = '正在安装 cc-connect...';
    try {
      const r = await fetch('/api/deps-check?fix=1', { method: 'POST' });
      const data = await r.json();
      if (data.ccConnect && data.ccConnect.ok) {
        setStatus('i-cc', 'ok', data.ccConnect.version);
        setProgress(80);
        document.getElementById('statusText').textContent = '安装完成 ✓';
        document.getElementById('statusText').style.color = '#3fb950';
        await runInstallEnv();
        setProgress(100);
        setTimeout(() => finalize(), 800);
      } else {
        setStatus('i-cc', 'fail', '安装失败');
        document.getElementById('statusText').textContent = '安装失败，请手动执行: npm install -g cc-connect@latest';
        document.getElementById('statusText').style.color = '#e5534b';
      }
    } catch(e) {
      document.getElementById('statusText').textContent = '安装失败: ' + e.message;
    }
  } else if (actionType === 'open') {
    finalize();
  }
}

async function runInstallEnv() {
  if (document.getElementById('setupEnv').checked) {
    try {
      await fetch('/api/setup-env', { method: 'POST' });
    } catch(e) { /* ignore */ }
  }
}

function finalize() {
  window.location.href = '/';
}

async function runCheck() {
  try {
    const r = await fetch('/api/deps-check', { method: 'POST' });
    const data = await r.json();
    setProgress(50);

    if (data.node) {
      setStatus('i-node', data.node.ok ? 'ok' : 'fail', data.node.version || data.node.error || '');
    }
    if (data.npm) {
      setStatus('i-npm', data.npm.ok ? 'ok' : 'fail', data.npm.version || data.npm.error || '');
    }
    if (data.ccConnect) {
      setStatus('i-cc', data.ccConnect.ok ? 'ok' : 'fail', data.ccConnect.version || data.ccConnect.error || '');
    }
    if (data.daemon) {
      setStatus('i-daemon', data.daemon.ok ? 'ok' : 'fail', data.daemon.status || '');
    }
    if (data.configExists !== undefined) {
      setStatus('i-config', data.configExists ? 'ok' : '—', data.configExists ? '' : '未创建');
    }

    setProgress(100);

    const allOk = data.node && data.node.ok && data.ccConnect && data.ccConnect.ok;
    if (allOk) {
      document.getElementById('statusText').textContent = '所有依赖已就绪 ✓';
      document.getElementById('statusText').style.color = '#3fb950';
      document.getElementById('envOption').classList.remove('hidden');
      actionType = 'open';
      showAction('打开配置页面');
    } else if (!data.node || !data.node.ok) {
      document.getElementById('statusText').textContent = '需要安装 Node.js';
      document.getElementById('statusText').style.color = '#e5534b';
    } else {
      actionType = 'install';
      document.getElementById('envOption').classList.remove('hidden');
      showAction('安装 cc-connect');
    }
  } catch(e) {
    setProgress(100);
    document.getElementById('statusText').textContent = '检测失败: ' + e.message;
    actionType = 'open';
    showAction('跳过检测，打开配置');
  }
}

runCheck();
</script></body></html>`;

// ── Create App Window ──────────────────────────────────────────────────────
let mainWindow = null;
let server = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    minWidth: 800, minHeight: 500,
    title: "cc-connect Config",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  // Show when ready to avoid white flash
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Load setup wizard (dependency check)
  const depScript = path.join(SCRIPTS_DIR, "install-check.js");
  if (fs.existsSync(depScript)) {
    try {
      const ccStatus = execSync(`node "${depScript}" --json`, { encoding: "utf-8", timeout: 5000 });
      const deps = JSON.parse(ccStatus);
      if (deps.node && deps.node.ok && deps.ccConnect && deps.ccConnect.ok) {
        mainWindow.loadURL(`http://localhost:${PORT}/`);
      } else {
        mainWindow.loadURL(`http://localhost:${PORT}/setup`);
      }
    } catch {
      mainWindow.loadURL(`http://localhost:${PORT}/setup`);
    }
  } else {
    mainWindow.loadURL(`http://localhost:${PORT}/`);
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Application Menu ───────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about", label: "About cc-connect Config" },
        { type: "separator" },
        { role: "hide", label: "隐藏" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "打开配置文件",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            shell.openPath(CONFIG_DIR).catch(() => {});
          },
        },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "cc-connect",
      submenu: [
        {
          label: "重启守护进程",
          accelerator: "CmdOrCtrl+R",
          click: () => execFile("cc-connect", ["daemon", "restart", "--work-dir", CONFIG_DIR],
            (err) => {
              if (mainWindow) mainWindow.webContents.send("daemon-restarted", err ? false : true);
            }),
        },
        {
          label: "查看运行状态",
          click: () => {
            try {
              const status = execSync("cc-connect daemon status --work-dir " + JSON.stringify(CONFIG_DIR),
                { encoding: "utf-8", timeout: 5000 });
              dialog.showMessageBox(mainWindow, {
                type: "info", title: "Daemon Status",
                message: status,
              });
            } catch {
              dialog.showErrorBox("Daemon Status", "cc-connect daemon is not running");
            }
          },
        },
        { type: "separator" },
        {
          label: "打开日志文件",
          click: () => {
            const logPath = path.join(CONFIG_DIR, "logs", "cc-connect.log");
            if (fs.existsSync(logPath)) shell.openPath(logPath).catch(() => {});
            else dialog.showErrorBox("Log", "No log file found");
          },
        },
        {
          label: "打开配置目录",
          click: () => shell.openPath(CONFIG_DIR).catch(() => {}),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "cc-connect GitHub",
          click: () => shell.openExternal("https://github.com/chenhg5/cc-connect"),
        },
        {
          label: "关于",
          click: () => dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "cc-connect Config",
            message: "cc-connect Config UI v1.0.0\n\nWeb-based configuration editor for cc-connect.",
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Dock Menu (macOS) ──────────────────────────────────────────────────────
function buildDockMenu() {
  if (process.platform !== "darwin") return;
  const dockMenu = Menu.buildFromTemplate([
    {
      label: "打开配置页面",
      click: () => {
        if (!mainWindow) createMainWindow();
        else mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "重启 cc-connect",
      click: () => {
        execFile("cc-connect", ["daemon", "restart", "--work-dir", CONFIG_DIR], (err) => {
          if (mainWindow) mainWindow.webContents.send("daemon-restarted", err ? false : true);
        });
      },
    },
    {
      label: "查看状态",
      click: () => {
        try {
          const status = execSync("cc-connect daemon status --work-dir " + JSON.stringify(CONFIG_DIR),
            { encoding: "utf-8", timeout: 5000 });
          dialog.showMessageBox({ type: "info", title: "Daemon Status", message: status });
        } catch {
          dialog.showErrorBox("Daemon Status", "cc-connect daemon is not running");
        }
      },
    },
  ]);
  app.dock.setMenu(dockMenu);
}

// ── App Lifecycle ──────────────────────────────────────────────────────────
server = http.createServer(onRequest);

app.on("ready", () => {
  buildMenu();
  buildDockMenu();

  server.listen(PORT, () => {
    console.log(`\n  cc-connect Config UI  —  http://localhost:${PORT}\n  Config: ${CONFIG_PATH}\n`);
    createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    server.listen(PORT, () => createMainWindow());
  } else {
    mainWindow.focus();
  }
});

app.on("will-quit", () => {
  if (server) server.close();
});
