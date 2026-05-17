#!/usr/bin/env node
"use strict";
/**
 * postinstall.js — post-install / post-update tasks
 *
 * Runs after npm install (via package.json "postinstall" script)
 * or after the Electron app is installed.
 *
 * Tasks:
 *   1. Ensure ~/.cc-connect directory exists
 *   2. Create minimal config.toml if missing
 *   3. Create config-ui-state.json if missing
 *   4. Prompt to register launchd daemon (if cc-connect is available)
 *   5. Set up environment variables (if --setup-env is passed)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CONFIG_DIR = path.resolve(process.env.HOME || "/tmp", ".cc-connect");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml");
const STATE_PATH = path.join(CONFIG_DIR, "config-ui-state.json");
const args = process.argv.slice(2);
const isSetupEnv = args.includes("--setup-env");

let exitCode = 0;

function log(label, msg) {
  console.log(`  [cc-connect] ${label.padEnd(12)} ${msg}`);
}

function ok(msg) { log("✓", msg); }
function info(msg) { log("•", msg); }
function warn(msg) { log("⚠", msg); }
function fail(msg) { log("✗", msg); exitCode = 1; }

// 1. Ensure config directory
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  ok(`Created config directory: ${CONFIG_DIR}`);
} else {
  info(`Config directory exists: ${CONFIG_DIR}`);
}

// 2. Create minimal config.toml if missing
if (!fs.existsSync(CONFIG_PATH)) {
  const toml = `# cc-connect configuration
language = "zh"

[log]
level = "info"

# Add your projects here, or use the Config UI:
#   http://localhost:4188
#
# Docs: https://github.com/chenhg5/cc-connect
`;
  fs.writeFileSync(CONFIG_PATH, toml, "utf-8");
  ok(`Created default config: ${CONFIG_PATH}`);
} else {
  info(`Config exists: ${CONFIG_PATH}`);
}

// 3. Create config-ui-state.json if missing
if (!fs.existsSync(STATE_PATH)) {
  const state = { feishuAppTemplates: [], userGroupTemplates: [] };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  ok(`Created UI state: ${STATE_PATH}`);
} else {
  info(`UI state exists: ${STATE_PATH}`);
}

// 4. Check cc-connect & daemon
try {
  const ccBin = execSync("command -v cc-connect", { encoding: "utf-8", timeout: 3000 }).trim();
  if (ccBin) {
    ok(`cc-connect found: ${ccBin}`);

    // Check daemon, install if not present
    try {
      const status = execSync(`cc-connect daemon status --work-dir ${JSON.stringify(CONFIG_DIR)}`, {
        encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      });
      if (status.includes("Running") || status.includes("Stopped")) {
        info("cc-connect daemon already installed");
      }
    } catch {
      // Not installed, install it
      info("Installing cc-connect daemon...");
      try {
        execSync(`cc-connect daemon install --work-dir ${JSON.stringify(CONFIG_DIR)}`, {
          encoding: "utf-8", timeout: 15000,
        });
        ok("cc-connect daemon installed");
      } catch (e) {
        warn(`Daemon install skipped (run manually: cc-connect daemon install)`);
      }
    }
  }
} catch {
  warn("cc-connect not found — skip daemon setup. Install with: npm install -g cc-connect@latest");
}

// 5. Environment setup (optional)
if (isSetupEnv) {
  const setupScript = path.join(__dirname, "setup-env.sh");
  if (fs.existsSync(setupScript)) {
    try {
      execSync(`/bin/zsh "${setupScript}" --apply`, { encoding: "utf-8", timeout: 5000 });
      ok("Environment variables configured");
    } catch (e) {
      warn("Environment setup failed: " + e.message);
    }
  }
}

console.log();
process.exit(exitCode);
