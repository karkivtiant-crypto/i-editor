const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const root = __dirname;
const preferredPort = Number(process.env.PORT || 4173);

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

async function main() {
  const existing = await probeServer(preferredPort);
  if (existing.compatible) {
    openBrowser(urlFor(preferredPort));
    return;
  }

  const port = existing.ready ? await findOpenPort(preferredPort + 1) : preferredPort;
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PORT: String(port) },
    });
  child.unref();
  await waitUntilReady(port);
  openBrowser(urlFor(port));
}

function urlFor(port) {
  return `http://localhost:${port}/`;
}

async function probeServer(port) {
  const rootReady = await requestOk(urlFor(port));
  const configReady = await requestOk(`${urlFor(port)}api/app-config`);
  return { ready: rootReady, compatible: rootReady && configReady };
}

function requestOk(targetUrl) {
  return new Promise((resolve) => {
    const request = http.get(targetUrl, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(800, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitUntilReady(port) {
  for (let index = 0; index < 40; index += 1) {
    if ((await probeServer(port)).compatible) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server failed to start on port ${port}.`);
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    const probe = await probeServer(port);
    if (!probe.ready) return port;
    if (probe.compatible) return port;
  }
  throw new Error("No available local port was found.");
}

function openBrowser(targetUrl) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
