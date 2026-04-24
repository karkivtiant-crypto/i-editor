let nextWorkerId = 1;
const pending = new Map();
const worker = new Worker("./metadata-worker.js", { type: "module" });
const workerTimeoutMs = 60_000;

worker.addEventListener("message", (event) => {
  const { id, ok, result, error } = event.data;
  const item = pending.get(id);
  if (!item) return;
  settlePending(id);
  if (ok) item.resolve(result);
  else item.reject(new Error(error || "Worker 处理失败"));
});

worker.addEventListener("error", () => {
  rejectAllPending(new Error("Worker 执行出错，请重试"));
});

worker.addEventListener("messageerror", () => {
  rejectAllPending(new Error("Worker 消息传输失败，请重试"));
});

export function readMetadataInWorker(bytes, type) {
  const transferableBytes = new Uint8Array(bytes);
  return callWorker("read", { bytes: transferableBytes, type }, [transferableBytes.buffer]);
}

export function writeImageInWorker(bytes, type, rows) {
  const transferableBytes = new Uint8Array(bytes);
  return callWorker("write", { bytes: transferableBytes, type, rows }, [transferableBytes.buffer]);
}

export function buildPreviewInWorker(type, rows) {
  return callWorker("preview", { type, rows });
}

function callWorker(action, payload, transfer = []) {
  const id = nextWorkerId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;
      settlePending(id);
      reject(new Error("Worker 处理超时，请重试"));
    }, workerTimeoutMs);
    pending.set(id, { resolve, reject, timeout });
    try {
      worker.postMessage({ id, action, ...payload }, transfer);
    } catch (error) {
      settlePending(id);
      reject(error);
    }
  });
}

function settlePending(id) {
  const item = pending.get(id);
  if (!item) return null;
  clearTimeout(item.timeout);
  pending.delete(id);
  return item;
}

function rejectAllPending(error) {
  Array.from(pending.keys()).forEach((id) => {
    const item = settlePending(id);
    if (item) item.reject(error);
  });
}
