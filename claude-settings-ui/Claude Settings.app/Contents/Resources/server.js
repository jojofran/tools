const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4177;
const SETTINGS_PATH = path.resolve(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "settings.json"
);

const LOCAL_SETTINGS_PATH = (() => {
  const cwdSettings = path.resolve(process.cwd(), ".claude", "settings.json");
  const cwdLocalSettings = path.resolve(
    process.cwd(),
    ".claude",
    "settings.local.json"
  );
  return { cwdSettings, cwdLocalSettings };
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const ROOT = __dirname;

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw: "{}", parsed: {} };
  }
}

function parseSettingsBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function getFileMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API routes
  if (pathname === "/api/settings" && req.method === "GET") {
    const { parsed, raw } = readJson(SETTINGS_PATH);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: SETTINGS_PATH, data: parsed, raw }));
    return;
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    try {
      const body = await parseSettingsBody(req);
      const formatted = JSON.stringify(body, null, 2) + "\n";
      fs.writeFileSync(SETTINGS_PATH, formatted, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: SETTINGS_PATH }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // info about all settings file locations
  if (pathname === "/api/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        global: getFileMetadata(SETTINGS_PATH),
        project: getFileMetadata(LOCAL_SETTINGS_PATH.cwdSettings),
        projectLocal: getFileMetadata(LOCAL_SETTINGS_PATH.cwdLocalSettings),
      })
    );
    return;
  }

  // Serve static files
  if (pathname === "/") {
    serveFile(res, path.join(ROOT, "index.html"));
  } else {
    const filePath = path.join(ROOT, pathname);
    if (filePath.startsWith(ROOT)) {
      serveFile(res, filePath);
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  Claude Settings UI → http://localhost:${PORT}\n`);
  console.log(`  Editing: ${SETTINGS_PATH}\n`);
});
