#!/usr/bin/env node
"use strict";
/**
 * install-check.js — Dependency checker & auto-installer for cc-connect
 *
 * Usage:
 *   node install-check.js           # check only, report JSON
 *   node install-check.js --fix     # auto-install missing deps
 *   node install-check.js --json    # output JSON (always on for --json)
 *
 * Exit codes:
 *   0 = all OK
 *   1 = missing critical (node/npm)
 *   2 = missing optional (cc-connect)
 */

const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const fixMode = args.includes("--fix");
const jsonMode = args.includes("--json") || !process.stdout.isTTY;

const CONFIG_DIR = path.resolve(process.env.HOME || "/tmp", ".cc-connect");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml");

function which(cmd) {
  try {
    const out = execSync(`command -v ${cmd} 2>/dev/null || which ${cmd} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function run(cmd, opts = {}) {
  try {
    return execFileSync("/bin/sh", ["-c", cmd], {
      encoding: "utf-8",
      timeout: opts.timeout || 60000,
      stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "pipe",
      ...opts,
    }).trim();
  } catch (e) {
    return { error: e.stderr || e.message };
  }
}

function checkNode() {
  const bin = which("node");
  if (!bin) return { ok: false, bin: null, version: null, error: "Node.js not found" };
  const ver = run("node --version", { silent: true });
  return { ok: true, bin, version: ver.replace(/^v/, "") };
}

function checkNpm() {
  const bin = which("npm");
  if (!bin) return { ok: false, bin: null, version: null, error: "npm not found" };
  const ver = run("npm --version", { silent: true });
  return { ok: true, bin, version: ver };
}

function checkCcConnect() {
  const bin = which("cc-connect");
  if (!bin) return { ok: false, bin: null, version: null, error: "cc-connect not found" };
  try {
    const ver = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    const match = ver.match(/(\d+\.\d+\.\d+)/);
    return { ok: true, bin, version: match ? match[1] : "unknown", full: ver };
  } catch {
    return { ok: true, bin, version: "unknown" };
  }
}

function checkDaemonInstalled() {
  const status = run("cc-connect daemon status --work-dir " + JSON.stringify(CONFIG_DIR), { silent: true, timeout: 5000 });
  if (typeof status === "string" && status.includes("Running")) {
    return { ok: true, status: "running" };
  }
  if (typeof status === "string" && status.includes("Stopped")) {
    return { ok: true, status: "stopped" };
  }
  return { ok: false, status: "not_installed" };
}

function checkConfigExists() {
  return fs.existsSync(CONFIG_PATH);
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function ensureMinimalConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const toml = `# cc-connect configuration
language = "zh"

[log]
level = "info"
`;
    fs.writeFileSync(CONFIG_PATH, toml, "utf-8");
    return { created: true };
  }
  return { created: false };
}

function installCcConnect() {
  console.log("  Installing cc-connect via npm...");
  const result = run("npm install -g cc-connect@latest", { silent: false, timeout: 120000 });
  if (typeof result === "string" && result.includes("npm")) {
    return { ok: true };
  }
  if (result.error) {
    return { ok: false, error: result.error };
  }
  // Check if it worked
  const cc = checkCcConnect();
  return { ok: cc.ok, error: cc.error };
}

function setupLaunchd() {
  const result = run("cc-connect daemon install --work-dir " + JSON.stringify(CONFIG_DIR), { silent: true, timeout: 15000 });
  if (typeof result === "string") {
    return { ok: true, output: result.trim() };
  }
  if (result && result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

async function main() {
  const node = checkNode();
  const npm = checkNpm();
  const ccConnect = checkCcConnect();
  const daemon = ccConnect.ok ? checkDaemonInstalled() : { ok: false, status: "skipped" };
  const configExists = checkConfigExists();

  const report = { node, npm, ccConnect, daemon, configExists, configPath: CONFIG_PATH };
  let exitCode = 0;

  if (!node.ok) exitCode = 1;
  else if (!npm.ok) exitCode = 1;
  else if (!ccConnect.ok) exitCode = 2;

  if (fixMode && !ccConnect.ok && node.ok && npm.ok) {
    // Ensure config directory exists before installing
    ensureConfigDir();
    const installResult = await installCcConnect();
    report.installResult = installResult;
    if (installResult.ok) {
      // Re-check
      const newCc = checkCcConnect();
      report.ccConnect = newCc;
      if (newCc.ok) {
        report.daemon = checkDaemonInstalled();
        if (!report.daemon.ok) {
          const launchdResult = setupLaunchd();
          report.launchdResult = launchdResult;
        }
        if (!checkConfigExists()) {
          report.configCreated = ensureMinimalConfig().created;
        }
      }
      exitCode = newCc.ok ? 0 : 2;
    } else {
      exitCode = 2;
    }
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log("\n  ┌─ cc-connect Dependency Check ──────────────────");
    console.log(`  │ Node.js     ${node.ok ? "✓" : "✗"} ${node.version || node.error}`);
    if (node.bin) console.log(`  │             ${node.bin}`);
    console.log(`  │ npm         ${npm.ok ? "✓" : "✗"} ${npm.version || npm.error}`);
    console.log(`  │ cc-connect  ${ccConnect.ok ? "✓" : "✗"} ${ccConnect.version || ccConnect.error}`);
    if (ccConnect.bin) console.log(`  │             ${ccConnect.bin}`);
    if (ccConnect.ok) {
      console.log(`  │ Daemon      ${daemon.ok ? "✓" : "—"} ${daemon.status || "not_installed"}`);
    }
    console.log(`  │ Config      ${configExists ? "✓ exists" : "— missing"}`);
    console.log(`  └───────────────────────────────────────────────`);

    if (fixMode && report.installResult) {
      console.log(`\n  Install: ${report.installResult.ok ? "✓ completed" : "✗ " + report.installResult.error}`);
    }
    if (!ccConnect.ok && node.ok && npm.ok) {
      console.log(`\n  Run with --fix to auto-install cc-connect`);
    }
    console.log();
  }

  process.exit(exitCode);
}

main().catch(e => {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ error: e.message }) + "\n");
  } else {
    console.error("Error:", e.message);
  }
  process.exit(1);
});
