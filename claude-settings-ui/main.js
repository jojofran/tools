const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 4177;
const SETTINGS_PATH = path.resolve(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "settings.json"
);
const VERSIONS_PATH = path.resolve(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "versions.json"
);

let mainWindow;
let server;

function startServer() {
  const ROOT = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : __dirname;

  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
  };

  function serveFile(res, filePath) {
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
      });
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

  function readVersions() {
    try {
      const raw = fs.readFileSync(VERSIONS_PATH, "utf-8");
      return { versions: JSON.parse(raw).versions || [] };
    } catch {
      return { versions: [] };
    }
  }

  function writeVersions(versions) {
    const maxVersions = 5;
    if (versions.length > maxVersions) {
      const favorites = versions.filter(v => v.favorite);
      const nonFavorites = versions.filter(v => !v.favorite);
      while (nonFavorites.length + favorites.length > maxVersions) {
        nonFavorites.shift();
      }
      versions.length = 0;
      versions.push(...nonFavorites, ...favorites);
      versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
    fs.writeFileSync(VERSIONS_PATH, JSON.stringify({ versions }, null, 2) + "\n", "utf-8");
  }

  function createVersionSummary(data) {
    const parts = [];
    if (data.model) parts.push(`Model: ${data.model}`);
    if (data.mcpServers && Object.keys(data.mcpServers).length > 0) {
      parts.push(`${Object.keys(data.mcpServers).length} MCP servers`);
    }
    if (data.permissions?.allow?.length) parts.push(`${data.permissions.allow.length} allow rules`);
    return parts.join(", ") || "(empty config)";
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

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname } = url;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

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

    if (pathname === "/api/info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          global: getFileMetadata(SETTINGS_PATH),
        })
      );
      return;
    }

    if (pathname === "/api/versions" && req.method === "GET") {
      const { versions } = readVersions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ versions }));
      return;
    }

    if (pathname === "/api/versions" && req.method === "POST") {
      try {
        const body = await parseSettingsBody(req);
        const { versions } = readVersions();

        const versionId = "v" + Math.floor(Date.now() / 1000);
        const newVersion = {
          id: versionId,
          timestamp: new Date().toISOString(),
          name: body.name || "Auto-saved",
          data: body.data || {},
          summary: createVersionSummary(body.data || {}),
        };

        versions.push(newVersion);
        writeVersions(versions);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: newVersion }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Update snapshot data: PUT /api/versions/:id (not restore/rename/favorite)
    if (req.method === "PUT" && pathname.startsWith("/api/versions/") && !pathname.endsWith("/restore") && !pathname.endsWith("/rename") && !pathname.endsWith("/favorite")) {
      try {
        const versionId = pathname.replace("/api/versions/", "");
        if (!versionId) throw new Error("Missing version ID");
        const body = await parseSettingsBody(req);
        const { versions } = readVersions();
        const version = versions.find((v) => v.id === versionId);
        if (!version) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Version not found" }));
          return;
        }
        version.data = body.data || {};
        version.summary = createVersionSummary(version.data);
        version.timestamp = new Date().toISOString();
        writeVersions(versions);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.startsWith("/api/versions/") && req.method === "DELETE") {
      try {
        const versionId = pathname.replace("/api/versions/", "");
        const { versions } = readVersions();
        const version = versions.find((v) => v.id === versionId);
        if (version && version.favorite) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Cannot delete a favorited snapshot. Unfavorite it first." }));
          return;
        }
        const filtered = versions.filter((v) => v.id !== versionId);
        writeVersions(filtered);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.startsWith("/api/versions/") && pathname.endsWith("/restore") && req.method === "PUT") {
      try {
        const versionId = pathname.replace(/\/api\/versions\//, "").replace(/\/restore$/, "");
        const { versions } = readVersions();
        const version = versions.find((v) => v.id === versionId);

        if (!version) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Version not found" }));
          return;
        }

        const formatted = JSON.stringify(version.data, null, 2) + "\n";
        fs.writeFileSync(SETTINGS_PATH, formatted, "utf-8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: version.data }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.startsWith("/api/versions/") && pathname.endsWith("/rename") && req.method === "PUT") {
      try {
        const versionId = pathname.replace(/\/api\/versions\//, "").replace(/\/rename$/, "");
        const body = await parseSettingsBody(req);
        const { versions } = readVersions();
        const version = versions.find((v) => v.id === versionId);

        if (!version) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Version not found" }));
          return;
        }

        version.name = body.name || version.name;
        writeVersions(versions);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Toggle favorite: PUT /api/versions/:id/favorite
    if (pathname.endsWith("/favorite") && req.method === "PUT") {
      try {
        const versionId = pathname.replace(/^\/api\/versions\//, "").replace(/\/favorite$/, "");
        const { versions } = readVersions();
        const version = versions.find((v) => v.id === versionId);
        if (!version) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Version not found" }));
          return;
        }
        version.favorite = !version.favorite;
        writeVersions(versions);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

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
    console.log(`Server running on port ${PORT}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      enableRemoteModule: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", () => {
  startServer();
  setTimeout(createWindow, 500);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("quit", () => {
  if (server) {
    server.close();
  }
});
