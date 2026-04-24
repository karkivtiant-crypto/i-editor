import { buildWritePreview, readMetadata, writeImageMetadata } from "./metadata-core.js";

self.addEventListener("message", async (event) => {
  const { id, action, bytes, type, rows } = event.data;
  try {
    if (action === "read") {
      const result = await readMetadata(bytes, type);
      self.postMessage({ id, ok: true, result });
    } else if (action === "write") {
      const output = await writeImageMetadata(bytes, type, rows);
      self.postMessage({ id, ok: true, result: output }, [output.buffer]);
    } else if (action === "preview") {
      self.postMessage({ id, ok: true, result: buildWritePreview(type, rows) });
    } else {
      self.postMessage({ id, ok: false, error: "未知 Worker 操作" });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || "处理失败" });
  }
});
