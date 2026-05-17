#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execSync, spawn } = require("child_process");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");

const PORT = 4188;
const CONFIG_DIR = path.resolve(process.env.HOME || process.env.USERPROFILE, ".cc-connect");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml");
const STATE_PATH = path.join(CONFIG_DIR, "config-ui-state.json");
const ROOT = __dirname;

// ---------- helpers ----------

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
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function daemonStatus() {
  try {
    const out = execSync("cc-connect daemon status --work-dir " + JSON.stringify(CONFIG_DIR), {
      encoding: "utf-8",
      timeout: 5000,
    });
    const m = out.match(/Status:\s+(\S+)/i);
    if (m && m[1].toLowerCase() === "running") return true;
  } catch { /* launchd check failed, fall through to process check */ }
  // Fallback: check if cc-connect process is actually running
  try {
    const out = execSync("pgrep -f cc-connect/bin/cc-connect", { encoding: "utf-8", timeout: 3000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------- API handlers ----------

function handleConfig(method, res, body) {
  if (method === "GET") {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        return jsonRes(res, 200, { config: {}, raw: "" });
      }
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const config = parseToml(raw);
      jsonRes(res, 200, { config, raw });
    } catch (e) {
      sendError(res, 500, "Failed to read config: " + e.message);
    }
    return;
  }

  if (method === "PUT") {
    try {
      const { config } = body;
      // backup existing
      if (fs.existsSync(CONFIG_PATH)) {
        fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".backup");
      }
      const toml = stringifyToml(config);
      fs.writeFileSync(CONFIG_PATH, toml, "utf-8");
      jsonRes(res, 200, { ok: true });
    } catch (e) {
      sendError(res, 500, "Failed to write config: " + e.message);
    }
    return;
  }

  sendError(res, 405, "Method not allowed");
}

function handleRestart(method, res) {
  if (method !== "POST") return sendError(res, 405, "Method not allowed");

  execFile(
    "cc-connect",
    ["daemon", "restart", "--work-dir", CONFIG_DIR],
    { timeout: 15000 },
    (err, stdout, stderr) => {
      if (err) {
        return jsonRes(res, 500, {
          error: "Restart failed",
          output: stderr || err.message,
        });
      }
      jsonRes(res, 200, { ok: true, output: stdout.trim() });
    }
  );
}

function handleInfo(method, res) {
  if (method !== "GET") return sendError(res, 405, "Method not allowed");
  const info = {
    configPath: CONFIG_PATH,
    statePath: STATE_PATH,
    daemonRunning: daemonStatus(),
    configExists: fs.existsSync(CONFIG_PATH),
  };
  if (info.configExists) {
    const stat = fs.statSync(CONFIG_PATH);
    info.configSize = stat.size;
    info.configModified = stat.mtime.toISOString();
  }
  jsonRes(res, 200, info);
}

function handleState(method, res, body) {
  if (method === "GET") {
    const state = readJsonSafe(STATE_PATH) || { feishuAppTemplates: [], userGroupTemplates: [] };
    return jsonRes(res, 200, state);
  }
  if (method === "PUT") {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(body, null, 2), "utf-8");
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      return sendError(res, 500, "Failed to write state: " + e.message);
    }
  }
  sendError(res, 405, "Method not allowed");
}

// ---------- parse body ----------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---------- router ----------

async function onRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;
  const pathname = url.pathname;

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // API routes
  if (pathname === "/api/config") {
    let body = null;
    if (method === "PUT") {
      try { body = await parseBody(req); } catch (e) { return sendError(res, 400, "Invalid JSON"); }
    }
    return handleConfig(method, res, body);
  }

  if (pathname === "/api/restart") {
    return handleRestart(method, res);
  }

  if (pathname === "/api/info") {
    return handleInfo(method, res);
  }

  if (pathname === "/api/state") {
    let body = null;
    if (method === "PUT") {
      try { body = await parseBody(req); } catch (e) { return sendError(res, 400, "Invalid JSON"); }
    }
    return handleState(method, res, body);
  }

  if (pathname === "/api/deps-check" && method === "POST") {
    const fix = url.searchParams.has("fix");
    const depScript = path.join(ROOT, "scripts", "install-check.js");
    if (!fs.existsSync(depScript)) return jsonRes(res, 200, { note: "scripts not bundled" });
    const child = spawn("node", [depScript, "--json", ...(fix ? ["--fix"] : [])]);
    let out = "";
    child.stdout.on("data", d => out += d);
    child.on("close", (code) => {
      try { return jsonRes(res, 200, { ...JSON.parse(out), exitCode: code }); }
      catch { return jsonRes(res, 200, { raw: out, exitCode: code }); }
    });
    return;
  }

  if (pathname === "/api/setup-env" && method === "POST") {
    const setupScript = path.join(ROOT, "scripts", "setup-env.sh");
    if (fs.existsSync(setupScript)) {
      execFile("/bin/zsh", [setupScript, "--apply"], { timeout: 5000 },
        (err, stdout) => {
          if (err) return jsonRes(res, 500, { error: err.message });
          jsonRes(res, 200, { ok: true, output: stdout.trim() });
        });
    } else {
      jsonRes(res, 200, { ok: true, note: "setup script not found" });
    }
    return;
  }

  if (pathname === "/api/pick-directory" && method === "POST") {
    execFile("/usr/bin/osascript", [
      "-e", 'tell app "System Events" to activate',
      "-e", 'POSIX path of (choose folder with prompt "选择项目工作目录:")'
    ], { timeout: 60000, encoding: "utf-8" }, (err, stdout) => {
      if (err) return jsonRes(res, 200, { cancelled: true });
      const dir = stdout.trim();
      // Verify it exists
      if (dir && fs.existsSync(dir)) {
        jsonRes(res, 200, { path: dir });
      } else {
        jsonRes(res, 200, { cancelled: true });
      }
    });
    return;
  }

  // Setup wizard page — in standalone mode redirect to main page
  if (pathname === "/setup") {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // Static files
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(ROOT, filePath);

  // Security: ensure it resolves under ROOT
  if (!filePath.startsWith(ROOT)) {
    return sendError(res, 403, "Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendError(res, 404, "Not found");
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- start ----------

const server = http.createServer(onRequest);
server.listen(PORT, () => {
  console.log(`\n  cc-connect Config UI  —  http://localhost:${PORT}\n  Config: ${CONFIG_PATH}\n`);
});
