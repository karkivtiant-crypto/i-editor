const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const rootDir = __dirname;
const memoryPath = path.join(rootDir, "info-memory.json");
const configPath = path.join(rootDir, "app-config.json");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const server = http.createServer(async (request, response) => {
  try {
    if (!isLocalRequest(request)) {
      sendText(response, 403, "Local access only");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (url.pathname === "/api/info-memory" || url.pathname === "/api/app-config") {
      await handleJsonFileApi(request, response, url.pathname === "/api/info-memory" ? {
        path: memoryPath,
        normalize: normalizeMemory,
      } : {
        path: configPath,
        normalize: normalizeConfig,
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed");
      return;
    }

    await serveStatic(url.pathname, request, response);
  } catch (error) {
    sendText(response, 500, error.message || "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`i-editor running at http://localhost:${port}/`);
});

async function handleJsonFileApi(request, response, target) {
  if (!isSameOrigin(request)) {
    sendText(response, 403, "Same-origin requests only");
    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, await readJsonFile(target.path, target.normalize));
    return;
  }

  if (request.method === "POST") {
    const body = await readBody(request, 5 * 1024 * 1024);
    const value = target.normalize(JSON.parse(body || "{}"));
    await fs.writeFile(target.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    sendJson(response, 200, { ok: true });
    return;
  }

  sendText(response, 405, "Method not allowed");
}

async function readJsonFile(filePath, normalize) {
  try {
    const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    return normalize(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.writeFile(filePath, "{}\n", "utf8");
      return {};
    }
    throw error;
  }
}

function normalizeConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const numberOrDefault = (key, fallback) => {
    const number = Number(input[key]);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  };

  return {
    customInfoFieldNames: Array.from(
      new Set(
        (Array.isArray(input.customInfoFieldNames) ? input.customInfoFieldNames : [])
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 200),
    memoryLocks: normalizeMemoryLocks(input.memoryLocks),
    initialVisibleRows: numberOrDefault("initialVisibleRows", 80),
    visibleRowsStep: numberOrDefault("visibleRowsStep", 80),
    maxInlineValueLength: numberOrDefault("maxInlineValueLength", 50000),
    collapsedPreviewLength: Math.min(
      numberOrDefault("collapsedPreviewLength", 1200),
      numberOrDefault("maxInlineValueLength", 50000),
    ),
    saveNameMode: normalizeSaveNameMode(input.saveNameMode),
    saveSuffixOptions: normalizeSaveSuffixOptions(input.saveSuffixOptions),
    defaultSaveSuffix: normalizeDefaultSaveSuffix(input.defaultSaveSuffix, input.saveSuffixOptions),
  };
}

function normalizeMemoryLocks(value) {
  const locks = {};
  if (!value || typeof value !== "object") return locks;
  Object.entries(value).forEach(([key, locked]) => {
    const cleanKey = String(key || "").trim().slice(0, 120);
    if (cleanKey) locks[cleanKey] = Boolean(locked);
  });
  return locks;
}

function normalizeSaveNameMode(value) {
  return value === "rename" ? "rename" : "suffix";
}

function normalizeSaveSuffixOptions(value) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(value) ? value : ["ieditor"])
        .map((item) => sanitizeFilenamePart(item))
        .filter(Boolean),
    ),
  ).slice(0, 50);
  return normalized.length > 0 ? normalized : ["ieditor"];
}

function normalizeDefaultSaveSuffix(value, options) {
  const cleanValue = sanitizeFilenamePart(value);
  if (cleanValue) return cleanValue;
  return normalizeSaveSuffixOptions(options)[0] || "ieditor";
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeMemory(value) {
  const output = {};
  if (!value || typeof value !== "object") return output;
  Object.entries(value).forEach(([key, entry]) => {
    const cleanKey = String(key || "").trim().slice(0, 120);
    if (!cleanKey) return;
    const list = Array.isArray(entry) ? entry : Array.isArray(entry?.items) ? entry.items : [];
    output[cleanKey] = Array.from(
      new Set(list.map((item) => String(item || "").trim()).filter(Boolean)),
    ).slice(0, 100);
  });
  return output;
}

async function serveStatic(pathname, request, response) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  const normalized = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, normalized);
  const relative = path.relative(rootDir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (request.method !== "HEAD") response.end(data);
    else response.end();
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isLocalRequest(request) {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(value);
}
