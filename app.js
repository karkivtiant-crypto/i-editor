import {
  buildPreviewInWorker,
  readMetadataInWorker,
  writeImageInWorker,
} from "./metadata-worker-client.js";
import { normalizeImageType } from "./metadata-core.js";

const $ = (selector) => document.querySelector(selector);
const textEncoder = new TextEncoder();

const fileInput = $("#fileInput");
const dropZone = $("#dropZone");
const urlForm = $("#urlForm");
const urlInput = $("#urlInput");
const urlLoadBtn = $("#urlLoadBtn");
const fileCard = $("#fileCard");
const preview = $("#preview");
const fileName = $("#fileName");
const fileType = $("#fileType");
const fileSize = $("#fileSize");
const metadataBody = $("#metadataBody");
const addRowBtn = $("#addRowBtn");
const saveBtn = $("#saveBtn");
const undoBtn = $("#undoBtn");
const redoBtn = $("#redoBtn");
const memoryBtn = $("#memoryBtn");
const dirtyPill = $("#dirtyPill");
const statusText = $("#statusText");
const statusDot = $("#statusDot");

const infoDialog = $("#infoDialog");
const infoForm = $("#infoForm");
const infoDialogSubtitle = $("#infoDialogSubtitle");
const closeInfoBtn = $("#closeInfoBtn");
const cancelInfoBtn = $("#cancelInfoBtn");
const saveInfoBtn = $("#saveInfoBtn");
const addInfoFieldBtn = $("#addInfoFieldBtn");

const writePreviewDialog = $("#writePreviewDialog");
const writePreviewText = $("#writePreviewText");
const closeWritePreviewBtn = $("#closeWritePreviewBtn");
const cancelWritePreviewBtn = $("#cancelWritePreviewBtn");
const confirmSaveBtn = $("#confirmSaveBtn");
const saveNamePreview = $("#saveNamePreview");
const saveNameModeSuffix = $("#saveNameModeSuffix");
const saveNameModeRename = $("#saveNameModeRename");
const saveNameSuffixFields = $("#saveNameSuffixFields");
const saveNameRenameField = $("#saveNameRenameField");
const saveSuffixInput = $("#saveSuffixInput");
const saveSuffixOptions = $("#saveSuffixOptions");
const saveSuffixRemember = $("#saveSuffixRemember");
const saveSuffixDefault = $("#saveSuffixDefault");
const saveRenameInput = $("#saveRenameInput");

const memoryDialog = $("#memoryDialog");
const memoryList = $("#memoryList");
const closeMemoryBtn = $("#closeMemoryBtn");
const clearMemoryBtn = $("#clearMemoryBtn");
const saveMemoryBtn = $("#saveMemoryBtn");

const defaultInfoFieldNames = [
  "Prompt",
  "Negative prompt",
  "Steps",
  "Sampler",
  "CFG scale",
  "Seed",
  "Size",
  "Model hash",
  "Model",
  "VAE",
  "Clip skip",
  "Denoising strength",
  "Lora hashes",
  "Workflow",
];

const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const writableTypes = ["image/jpeg", "image/png", "image/webp"];
const maxUrlImageBytes = 80 * 1024 * 1024;
const defaultAppConfig = {
  customInfoFieldNames: [],
  memoryLocks: {},
  initialVisibleRows: 80,
  visibleRowsStep: 80,
  maxInlineValueLength: 50000,
  collapsedPreviewLength: 1200,
  saveNameMode: "suffix",
  saveSuffixOptions: ["ieditor"],
  defaultSaveSuffix: "ieditor",
};
const appConfigStorageKey = "i-editor-app-config";
const memoryStorageKey = "i-editor-info-memory";
const configApiPath = "/api/app-config";
const memoryApiPath = "/api/info-memory";
const maxMemoryItemsPerType = 80;
const memoryLockedTitle = "已锁定：保存信息读取弹窗时不会向此类型新增记忆。";
const historyLimit = 100;

let currentFile = null;
let currentBytes = null;
let currentType = "";
let previewObjectUrl = "";
let metadataRows = [];
let visibleRowLimit = 0;
let expandedLongRows = new Set();
let activeInfoRowIndex = -1;
let activeInfoParse = null;
let appConfig = normalizeAppConfig(readLocalAppConfig());
let infoFieldNames = mergeInfoFieldNames(appConfig.customInfoFieldNames);
let infoMemory = {};
let memoryLoaded = false;
let memoryBackend = "localStorage";
let configBackend = "localStorage";
let undoStack = [];
let redoStack = [];
let isDirty = false;
let pendingSaveRows = null;
let pendingSaveRandomSuffix = "";
const exportInfoCache = new WeakMap();

initializeLocalState();

window.addEventListener("beforeunload", revokePreviewObjectUrl);

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) loadFile(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const [file] = event.dataTransfer.files;
  if (file) loadFile(file);
});

urlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadImageFromUrl(urlInput.value);
});

addRowBtn.addEventListener("click", () => {
  commitRows(() => {
    metadataRows.push({ key: "", value: "", source: "自定义" });
    visibleRowLimit = Math.max(visibleRowLimit, metadataRows.length);
  });
});

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);
saveBtn.addEventListener("click", openWritePreview);
confirmSaveBtn.addEventListener("click", saveCurrentImage);
closeWritePreviewBtn.addEventListener("click", closeWritePreview);
cancelWritePreviewBtn.addEventListener("click", closeWritePreview);
saveNameModeSuffix.addEventListener("change", syncSaveNameUi);
saveNameModeRename.addEventListener("change", syncSaveNameUi);
saveSuffixInput.addEventListener("input", syncSaveNameUi);
saveSuffixRemember.addEventListener("change", syncSaveNameUi);
saveSuffixDefault.addEventListener("change", syncSaveNameUi);
saveRenameInput.addEventListener("input", syncSaveNameUi);
memoryBtn.addEventListener("click", openMemoryManager);
closeMemoryBtn.addEventListener("click", closeMemoryManager);
clearMemoryBtn.addEventListener("click", () => {
  if (confirm("确定清空全部记忆内容吗？")) {
    infoMemory = {};
    renderMemoryManager();
  }
});
saveMemoryBtn.addEventListener("click", async () => {
  readMemoryManager();
  const configSaved = await saveAppConfig();
  await saveInfoMemory();
  closeMemoryManager();
  setStatus(configSaved ? "记忆内容与锁定配置已保存" : "记忆已保存到浏览器，本地配置文件写入失败", configSaved);
});

closeInfoBtn.addEventListener("click", closeInfoDialog);
cancelInfoBtn.addEventListener("click", closeInfoDialog);
addInfoFieldBtn.addEventListener("click", addCustomInfoField);
saveInfoBtn.addEventListener("click", saveInfoDialogValues);

async function loadImageFromUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return setStatus("请输入图片 URL", false);

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return setStatus("图片 URL 格式无效", false);
  }

  if (!["http:", "https:", "data:"].includes(parsedUrl.protocol)) {
    return setStatus("仅支持 http、https 或 data:image URL", false);
  }

  setUrlLoading(true);
  setStatus("正在读取 URL 图片...", true);
  try {
    const file = parsedUrl.protocol === "data:" ? dataUrlToImageFile(url) : await fetchImageFile(parsedUrl);
    await loadFile(file);
    setStatus(`已从 URL 读取图片：${file.name}`, true);
  } catch (error) {
    setStatus(error.message || "URL 图片读取失败", false);
  } finally {
    setUrlLoading(false);
  }
}

async function fetchImageFile(url) {
  let response;
  try {
    response = await fetch(url.href, { mode: "cors" });
  } catch {
    throw new Error("无法读取该 URL，可能被网站跨域策略阻止");
  }
  if (!response.ok) throw new Error(`URL 请求失败：HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > maxUrlImageBytes) {
    throw new Error(`URL 图片过大，最大支持 ${formatSize(maxUrlImageBytes)}`);
  }
  const blob = await response.blob();
  if (blob.size > maxUrlImageBytes) {
    throw new Error(`URL 图片过大，最大支持 ${formatSize(maxUrlImageBytes)}`);
  }
  const type = normalizeImageType(blob.type || "", url.href);
  if (!supportedTypes.includes(type)) throw new Error("URL 对应文件不是支持的图片格式");
  return new File([blob], filenameFromUrl(url.href, type), { type });
}

function dataUrlToImageFile(value) {
  const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) throw new Error("data URL 格式无效");
  const type = normalizeImageType(match[1] || "");
  if (!supportedTypes.includes(type)) throw new Error("data URL 不是支持的图片格式");
  if (estimateDataUrlBytes(match[3], Boolean(match[2])) > maxUrlImageBytes) {
    throw new Error(`data URL 图片过大，最大支持 ${formatSize(maxUrlImageBytes)}`);
  }
  const bytes = match[2] ? base64ToBytes(match[3]) : textEncoder.encode(decodeURIComponent(match[3]));
  if (bytes.length > maxUrlImageBytes) {
    throw new Error(`data URL 图片过大，最大支持 ${formatSize(maxUrlImageBytes)}`);
  }
  return new File([bytes], `url-image.${extensionFromType(type)}`, { type });
}

function setUrlLoading(loading) {
  urlLoadBtn.disabled = loading;
  urlInput.disabled = loading;
  urlLoadBtn.textContent = loading ? "读取中" : "读取";
}

async function loadFile(file) {
  const type = normalizeImageType(file.type, file.name);
  if (!supportedTypes.includes(type)) return setStatus("请上传 JPEG、PNG、WebP 或 AVIF 图片", false);

  currentFile = file;
  currentType = type;
  currentBytes = new Uint8Array(await file.arrayBuffer());
  revokePreviewObjectUrl();
  previewObjectUrl = URL.createObjectURL(file);
  preview.src = previewObjectUrl;
  fileName.textContent = file.name;
  fileType.textContent = type;
  fileSize.textContent = formatSize(file.size);
  fileCard.hidden = false;

  addRowBtn.disabled = true;
  saveBtn.disabled = true;
  setStatus("正在后台解析元数据...", true);
  try {
    metadataRows = await readMetadataInWorker(currentBytes, currentType);
    if (metadataRows.length === 0) metadataRows.push({ key: "Description", value: "", source: "自定义" });
    visibleRowLimit = Math.min(appConfig.initialVisibleRows, metadataRows.length);
    expandedLongRows = new Set();
    undoStack = [];
    redoStack = [];
    setDirty(false);
    renderRows();
    addRowBtn.disabled = false;
    saveBtn.disabled = !writableTypes.includes(currentType);
    setStatus(writableTypes.includes(currentType) ? buildRowsStatus() : `${buildRowsStatus()}，该格式暂不支持写入`, true);
  } catch (error) {
    setStatus(error.message || "解析失败", false);
  }
}

function renderRows() {
  metadataBody.innerHTML = "";
  const rowsToRender = metadataRows.slice(0, visibleRowLimit || metadataRows.length);
  const fragment = document.createDocumentFragment();

  rowsToRender.forEach((row, index) => {
    const exportInfo = getCachedExportInfo(row);
    const renderedValue = getRenderedFieldValue(row.value || "", index);
      const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="字段"><input class="cell-input" aria-label="字段名" value="${escapeAttr(row.key)}" /></td>
      <td data-label="值">
        <textarea class="cell-textarea" aria-label="字段值"${renderedValue.collapsed ? " readonly" : ""}>${escapeHtml(renderedValue.value)}</textarea>
        ${renderedValue.isLong ? `<div class="field-note">${renderedValue.collapsed ? "字段内容较长，当前仅显示预览。" : "已载入全文，可直接编辑。"}</div>` : ""}
        ${renderedValue.isLong ? `<button class="secondary-btn fold-btn" type="button">${renderedValue.collapsed ? "解除折叠" : "折叠"}</button>` : ""}
      </td>
      <td data-label="来源"><span class="source-pill">${escapeHtml(row.source || "自定义")}</span></td>
      <td data-label="操作">
        <div class="row-actions">
          ${exportInfo ? `<button class="export-btn label-btn" type="button">导出 ${escapeHtml(exportInfo.label)}</button>` : ""}
          <button class="inspect-btn" type="button" aria-label="信息读取" title="信息读取">i</button>
          <button class="remove-btn" type="button" aria-label="删除字段" title="删除字段">×</button>
        </div>
      </td>
    `;

    const keyInput = tr.querySelector("input");
    const valueInput = tr.querySelector("textarea");
    keyInput.addEventListener("change", () => updateRow(index, { key: keyInput.value }));
    valueInput.addEventListener("change", () => updateRow(index, { value: valueInput.value }));
    tr.querySelector(".fold-btn")?.addEventListener("click", () => {
      if (expandedLongRows.has(index)) expandedLongRows.delete(index);
      else expandedLongRows.add(index);
      renderRows();
    });
    tr.querySelector(".inspect-btn").addEventListener("click", () => openInfoDialog(index));
    tr.querySelector(".export-btn")?.addEventListener("click", () => exportFieldValue(index));
    tr.querySelector(".remove-btn").addEventListener("click", () => {
      commitRows(() => {
        metadataRows.splice(index, 1);
        expandedLongRows = new Set();
      });
    });
    fragment.appendChild(tr);
  });

  metadataBody.appendChild(fragment);
  if (metadataRows.length > rowsToRender.length) {
    const tr = document.createElement("tr");
    tr.className = "load-more-row";
    tr.innerHTML = `<td colspan="4"><button class="secondary-btn load-more-btn" type="button">显示更多字段（${rowsToRender.length}/${metadataRows.length}）</button></td>`;
    tr.querySelector("button").addEventListener("click", () => {
      visibleRowLimit = Math.min(metadataRows.length, visibleRowLimit + appConfig.visibleRowsStep);
      renderRows();
      setStatus(buildRowsStatus(), true);
    });
    metadataBody.appendChild(tr);
  }
  if (metadataRows.length === 0) metadataBody.innerHTML = '<tr class="empty-row"><td colspan="4">当前没有元数据字段。</td></tr>';
  updateHistoryButtons();
}

function updateRow(index, patch) {
  commitRows(() => {
    metadataRows[index] = { ...metadataRows[index], ...patch };
  });
}

function commitRows(mutator, dirty = true) {
  const beforeRows = metadataRows.slice();
  mutator();
  const patch = createRowsPatch(beforeRows, metadataRows);
  if (patch) {
    undoStack.push(patch);
    if (undoStack.length > historyLimit) undoStack.shift();
    redoStack = [];
    if (dirty) setDirty(true);
  }
  renderRows();
}

function undo() {
  if (undoStack.length === 0) return;
  const patch = undoStack.pop();
  applyRowsPatch(patch, "undo");
  redoStack.push(patch);
  expandedLongRows = new Set();
  setDirty(true);
  renderRows();
}

function redo() {
  if (redoStack.length === 0) return;
  const patch = redoStack.pop();
  applyRowsPatch(patch, "redo");
  undoStack.push(patch);
  expandedLongRows = new Set();
  setDirty(true);
  renderRows();
}

function updateHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

function setDirty(value) {
  isDirty = value;
  dirtyPill.hidden = !isDirty;
}

function createRowsPatch(beforeRows, afterRows) {
  const minLength = Math.min(beforeRows.length, afterRows.length);
  let start = 0;
  while (start < minLength && beforeRows[start] === afterRows[start]) start += 1;

  let beforeEnd = beforeRows.length - 1;
  let afterEnd = afterRows.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeRows[beforeEnd] === afterRows[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const beforeSlice = beforeRows.slice(start, beforeEnd + 1);
  const afterSlice = afterRows.slice(start, afterEnd + 1);
  if (beforeSlice.length === 0 && afterSlice.length === 0) return null;
  return { index: start, beforeRows: beforeSlice, afterRows: afterSlice };
}

function applyRowsPatch(patch, direction) {
  const undoing = direction === "undo";
  const removeCount = undoing ? patch.afterRows.length : patch.beforeRows.length;
  const insertRows = undoing ? patch.beforeRows : patch.afterRows;
  metadataRows.splice(patch.index, removeCount, ...insertRows);
}

function revokePreviewObjectUrl() {
  if (!previewObjectUrl) return;
  URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = "";
}

async function openWritePreview() {
  if (!currentBytes || !writableTypes.includes(currentType)) return;
  pendingSaveRows = collectRows();
  try {
    populateSaveNameForm();
    writePreviewText.textContent = await buildPreviewInWorker(currentType, pendingSaveRows);
    writePreviewDialog.showModal();
  } catch (error) {
    setStatus(error.message || "生成预览失败", false);
  }
}

function closeWritePreview() {
  pendingSaveRows = null;
  pendingSaveRandomSuffix = "";
  if (writePreviewDialog.open) writePreviewDialog.close();
}

async function saveCurrentImage() {
  try {
    const rows = pendingSaveRows || collectRows();
    const saveNameConfig = readSaveNameConfig();
    confirmSaveBtn.disabled = true;
    const output = await writeImageInWorker(currentBytes, currentType, rows);
    const configSaved = await persistSaveNameConfig(saveNameConfig);
    const outputName = buildOutputName(currentFile.name, saveNameConfig);
    downloadBytes(output, outputName, currentType);
    setDirty(false);
    closeWritePreview();
    setStatus(configSaved ? `已生成修改后的图片：${outputName}` : `已生成修改后的图片：${outputName}，命名配置未写入文件`, true);
  } catch (error) {
    setStatus(error.message || "保存失败", false);
  } finally {
    confirmSaveBtn.disabled = false;
  }
}

async function openInfoDialog(rowIndex) {
  if (!memoryLoaded) await loadInfoMemory();
  const parsed = parseInfoBlock(metadataRows[rowIndex].value || "");
  if (!parsed) return setStatus("该字段中没有找到可读取的生成参数", false);
  activeInfoRowIndex = rowIndex;
  activeInfoParse = parsed;
  infoDialogSubtitle.textContent = `字段：${metadataRows[rowIndex].key || "未命名字段"}`;
  renderInfoForm(parsed.values);
  infoDialog.showModal();
}

function closeInfoDialog() {
  if (infoDialog.open) infoDialog.close();
  activeInfoRowIndex = -1;
  activeInfoParse = null;
}

function renderInfoForm(values) {
  infoForm.innerHTML = "";
  infoFieldNames.forEach((name) => {
    const locked = isMemoryLocked(name);
    const field = document.createElement("div");
    field.className = "info-field";
    if (locked) field.classList.add("memory-locked");
    const label = document.createElement("label");
    label.textContent = name;
    if (locked) label.title = memoryLockedTitle;
    const input = name === "Lora hashes" || name === "Workflow" || name === "Prompt" || name === "Negative prompt"
      ? document.createElement("textarea")
      : document.createElement("input");
    input.value = values[name] || "";
    input.dataset.infoName = name;
    field.append(label, input);
    const remembered = getRememberedValues(name);
    if (remembered.length > 0) {
      const select = document.createElement("select");
      select.className = "memory-select";
      select.innerHTML = `<option value="">选择历史内容</option>`;
      remembered.forEach((item) => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        if (select.value) input.value = select.value;
        select.value = "";
      });
      field.appendChild(select);
    }
    infoForm.appendChild(field);
  });
}

function addCustomInfoField() {
  const name = prompt("请输入新的参数类型名称");
  const clean = String(name || "").trim();
  if (!clean || infoFieldNames.includes(clean)) return;
  infoFieldNames.push(clean);
  saveInfoFieldNames();
  renderInfoForm(readInfoFormValues());
}

async function saveInfoDialogValues() {
  if (!activeInfoParse || activeInfoRowIndex < 0) return;
  const values = readInfoFormValues();
  const changed = hasInfoValuesChanged(activeInfoParse.values, values);
  const updatedBlock = formatInfoBlock(values);
  const originalValue = metadataRows[activeInfoRowIndex].value || "";
  await rememberInfoValues(values);
  commitRows(() => {
    metadataRows[activeInfoRowIndex].value =
      originalValue.slice(0, activeInfoParse.start) + updatedBlock + originalValue.slice(activeInfoParse.end);
  });
  setStatus(changed ? "已保存修改并记忆填写内容" : "已保存信息读取窗口中的修改", true);
  closeInfoDialog();
}

function readInfoFormValues() {
  const values = {};
  infoForm.querySelectorAll("[data-info-name]").forEach((input) => {
    values[input.dataset.infoName] = input.value;
  });
  return values;
}

function parseInfoBlock(text) {
  const sdStart = text.search(/(?:^|\n)(Prompt:|Steps:|Negative prompt:)/);
  const jsonStart = text.search(/(?:^|\n)\s*\{[\s\S]*"(?:nodes|workflow|prompt)"[\s\S]*\}/);
  const start = sdStart !== -1 ? sdStart + (text[sdStart] === "\n" ? 1 : 0) : jsonStart;
  if (start === -1) return null;

  if (jsonStart !== -1 && (sdStart === -1 || jsonStart < sdStart)) {
    const block = text.slice(jsonStart).trim();
    return { start: jsonStart, end: text.length, values: { Workflow: block } };
  }

  const end = text.length;
  const block = text.slice(start, end).trim();
  const values = Object.fromEntries(infoFieldNames.map((name) => [name, ""]));

  const negMatch = block.match(/Negative prompt:\s*([\s\S]*?)(?=\nSteps:|$)/);
  const promptMatch = block.match(/^(?:Prompt:\s*)?([\s\S]*?)(?=\nNegative prompt:|\nSteps:|Steps:|$)/);
  if (promptMatch && promptMatch[1].trim() && !promptMatch[1].trim().startsWith("Steps:")) values["Prompt"] = promptMatch[1].trim();
  if (negMatch) values["Negative prompt"] = negMatch[1].trim();

  const stepsIndex = block.indexOf("Steps:");
  const params = stepsIndex === -1 ? block : block.slice(stepsIndex);
  splitInfoParts(params.replace(/\n/g, ", ")).forEach((part) => {
    const separator = part.indexOf(":");
    if (separator === -1) return;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim().replace(/^"|"$/g, "");
    if (key) {
      if (!infoFieldNames.includes(key)) {
        infoFieldNames.push(key);
        saveInfoFieldNames();
      }
      values[key] = value;
    }
  });
  if (!("Model hash" in values)) values["Model hash"] = "";
  return { start, end, values };
}

function splitInfoParts(text) {
  const parts = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      current += char;
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (!quoted && "{[(".includes(char)) {
      depth += 1;
      current += char;
    } else if (!quoted && "}])".includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === "," && !quoted && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function formatInfoBlock(values) {
  const lines = [];
  if (values.Prompt) lines.push(values.Prompt.startsWith("Prompt:") ? values.Prompt : `Prompt: ${values.Prompt}`);
  if (values["Negative prompt"]) lines.push(`Negative prompt: ${values["Negative prompt"]}`);
  const hasNonWorkflowValue = infoFieldNames.some((name) => name !== "Workflow" && String(values[name] || "").trim());
  if (values.Workflow && !hasNonWorkflowValue) return values.Workflow;
  const params = infoFieldNames
    .filter((name) => !["Prompt", "Negative prompt", "Workflow"].includes(name))
    .filter((name) => String(values[name] || "").trim())
    .map((name) => {
      const value = String(values[name] || "").trim();
      return name === "Lora hashes" ? `${name}: "${value}"` : `${name}: ${value}`;
    });
  if (params.length > 0) lines.push(params.join(", "));
  if (values.Workflow) lines.push(`Workflow: ${values.Workflow}`);
  return lines.filter(Boolean).join("\n");
}

async function initializeLocalState() {
  await loadAppConfig();
  await loadInfoMemory();
}

async function loadAppConfig() {
  appConfig = normalizeAppConfig(readLocalAppConfig());

  if (location.protocol === "http:" || location.protocol === "https:") {
    try {
      const response = await fetch(configApiPath, { cache: "no-store" });
      if (response.ok) {
        appConfig = normalizeAppConfig(await response.json());
        configBackend = "file";
      }
    } catch {
      configBackend = "localStorage";
    }
  }

  infoFieldNames = mergeInfoFieldNames(appConfig.customInfoFieldNames);
  localStorage.setItem(appConfigStorageKey, JSON.stringify(appConfig));
}

function readLocalAppConfig() {
  try {
    return JSON.parse(localStorage.getItem(appConfigStorageKey) || "{}");
  } catch {
    return {};
  }
}

async function saveAppConfig() {
  appConfig = normalizeAppConfig(appConfig);
  localStorage.setItem(appConfigStorageKey, JSON.stringify(appConfig));

  if (location.protocol !== "http:" && location.protocol !== "https:") {
    configBackend = "localStorage";
    return false;
  }

  try {
    const response = await fetch(configApiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appConfig),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    configBackend = "file";
    return true;
  } catch {
    configBackend = "localStorage";
    return false;
  }
}

function normalizeAppConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const numberOrDefault = (key) => {
    const number = Number(input[key]);
    const fallback = defaultAppConfig[key];
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
    initialVisibleRows: numberOrDefault("initialVisibleRows"),
    visibleRowsStep: numberOrDefault("visibleRowsStep"),
    maxInlineValueLength: numberOrDefault("maxInlineValueLength"),
    collapsedPreviewLength: Math.min(
      numberOrDefault("collapsedPreviewLength"),
      numberOrDefault("maxInlineValueLength"),
    ),
    saveNameMode: normalizeSaveNameMode(input.saveNameMode),
    saveSuffixOptions: normalizeSaveSuffixOptions(input.saveSuffixOptions),
    defaultSaveSuffix: normalizeDefaultSaveSuffix(input.defaultSaveSuffix, input.saveSuffixOptions),
  };
}

function normalizeMemoryLocks(value) {
  const locks = {};
  if (!value || typeof value !== "object") return locks;
  Object.entries(value).forEach(([name, locked]) => {
    const cleanName = String(name || "").trim();
    if (cleanName) locks[cleanName] = Boolean(locked);
  });
  return locks;
}

async function loadInfoMemory() {
  const localMemory = readLocalInfoMemory();
  await migrateMemoryLocks(localMemory);
  infoMemory = normalizeInfoMemory(localMemory);
  if (location.protocol === "http:" || location.protocol === "https:") {
    try {
      const response = await fetch(memoryApiPath, { cache: "no-store" });
      if (response.ok) {
        const rawMemory = await response.json();
        await migrateMemoryLocks(rawMemory);
        infoMemory = normalizeInfoMemory(rawMemory);
        memoryBackend = "file";
      }
    } catch {
      memoryBackend = "localStorage";
    }
  }
  memoryLoaded = true;
}

function readLocalInfoMemory() {
  try {
    return JSON.parse(localStorage.getItem(memoryStorageKey) || "{}");
  } catch {
    return {};
  }
}

async function migrateMemoryLocks(rawMemory) {
  if (!rawMemory || typeof rawMemory !== "object") return;
  let changed = false;
  Object.entries(rawMemory).forEach(([name, entry]) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.locked) {
      if (!appConfig.memoryLocks[name]) {
        appConfig.memoryLocks[name] = true;
        changed = true;
      }
      delete entry.locked;
      changed = true;
    }
  });
  if (changed) await saveAppConfig();
}

async function rememberInfoValues(values) {
  let changed = false;
  Object.entries(values).forEach(([name, raw]) => {
    const value = String(raw || "").trim();
    if (!value) return;
    if (isMemoryLocked(name)) return;
    const existing = getRememberedValues(name);
    const next = [value, ...existing.filter((item) => item !== value)].slice(0, maxMemoryItemsPerType);
    if (next.join("\0") !== existing.join("\0")) {
      infoMemory[name] = next;
      changed = true;
    }
  });
  if (changed) await saveInfoMemory();
}

async function saveInfoMemory() {
  infoMemory = normalizeInfoMemory(infoMemory);
  localStorage.setItem(memoryStorageKey, JSON.stringify(infoMemory));
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  try {
    const response = await fetch(memoryApiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(infoMemory),
    });
    if (response.ok) memoryBackend = "file";
  } catch {
    memoryBackend = "localStorage";
  }
}

function getRememberedValues(name) {
  const entry = infoMemory[name];
  if (Array.isArray(entry)) return entry;
  return Array.isArray(entry?.items) ? entry.items : [];
}

function isMemoryLocked(name) {
  return Boolean(appConfig.memoryLocks?.[name]);
}

function normalizeInfoMemory(value) {
  const normalized = {};
  if (!value || typeof value !== "object") return normalized;
  Object.entries(value).forEach(([name, entry]) => {
    const items = Array.isArray(entry) ? entry : Array.isArray(entry?.items) ? entry.items : [];
    normalized[name] = Array.from(
      new Set(items.map((item) => String(item || "").trim()).filter(Boolean)),
    ).slice(0, maxMemoryItemsPerType);
  });
  infoFieldNames.forEach((name) => {
    if (!normalized[name]) normalized[name] = [];
  });
  return normalized;
}

function hasInfoValuesChanged(previous, next) {
  return Object.keys(next).some((name) => String(previous[name] || "") !== String(next[name] || ""));
}

async function openMemoryManager() {
  if (!memoryLoaded) await loadInfoMemory();
  renderMemoryManager();
  memoryDialog.showModal();
}

function closeMemoryManager() {
  if (memoryDialog.open) memoryDialog.close();
}

function renderMemoryManager() {
  memoryList.innerHTML = "";
  Object.keys(normalizeInfoMemory(infoMemory)).sort().forEach((name) => {
    const locked = isMemoryLocked(name);
    const group = document.createElement("section");
    group.className = "memory-group";
    group.innerHTML = `
      <div class="memory-group-header">
        <button type="button" class="lock-memory-btn ${locked ? "locked" : ""}" data-type="${escapeAttr(name)}" aria-label="${locked ? "解锁" : "锁定"} ${escapeAttr(name)}" title="${locked ? "解锁" : "锁定"}">
          ${locked ? "🔒" : "🔓"}
        </button>
        <h3 class="${locked ? "memory-locked-title" : ""}"${locked ? ` title="${escapeAttr(memoryLockedTitle)}"` : ""}>${escapeHtml(name)}</h3>
      </div>
    `;
    group.querySelector(".lock-memory-btn").addEventListener("click", async () => {
      appConfig.memoryLocks[name] = !isMemoryLocked(name);
      const saved = await saveAppConfig();
      if (!saved) setStatus("锁定状态已保存到浏览器，但未写入 app-config.json", false);
      renderMemoryManager();
    });
    getRememberedValues(name).forEach((value, index) => {
      const row = document.createElement("div");
      row.className = "memory-row";
      row.innerHTML = `<textarea data-type="${escapeAttr(name)}" data-index="${index}">${escapeHtml(value)}</textarea><button type="button" class="remove-memory-btn">删除</button>`;
      row.querySelector("button").addEventListener("click", () => {
        infoMemory[name].splice(index, 1);
        renderMemoryManager();
      });
      group.appendChild(row);
    });
    memoryList.appendChild(group);
  });
}

function readMemoryManager() {
  const next = {};
  Object.keys(infoMemory).forEach((type) => {
    next[type] = [];
  });
  memoryList.querySelectorAll("textarea[data-type]").forEach((textarea) => {
    const type = textarea.dataset.type;
    const value = textarea.value.trim();
    if (!value) return;
    if (!next[type]) next[type] = [];
    next[type].push(value);
  });
  infoMemory = normalizeInfoMemory(next);
}

function mergeInfoFieldNames(customNames) {
  return Array.from(
    new Set([
      ...defaultInfoFieldNames,
      ...(Array.isArray(customNames) ? customNames : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ]),
  );
}

function populateSaveNameForm() {
  const defaultSuffix = appConfig.defaultSaveSuffix || "ieditor";
  pendingSaveRandomSuffix = buildRandomSuffix();
  saveNameModeSuffix.checked = appConfig.saveNameMode !== "rename";
  saveNameModeRename.checked = appConfig.saveNameMode === "rename";
  saveSuffixInput.value = defaultSuffix;
  saveSuffixRemember.checked = false;
  saveSuffixDefault.checked = false;
  saveRenameInput.value = fileBaseName(currentFile?.name || "image");
  renderSaveSuffixOptions();
  syncSaveNameUi();
}

function renderSaveSuffixOptions() {
  saveSuffixOptions.innerHTML = "";
  appConfig.saveSuffixOptions.forEach((suffix) => {
    const option = document.createElement("option");
    option.value = suffix;
    saveSuffixOptions.appendChild(option);
  });
}

function syncSaveNameUi() {
  const suffixMode = saveNameModeSuffix.checked;
  saveNameSuffixFields.classList.toggle("is-hidden", !suffixMode);
  saveNameRenameField.classList.toggle("is-hidden", suffixMode);
  saveNameModeSuffix.setAttribute("aria-selected", suffixMode ? "true" : "false");
  saveNameModeRename.setAttribute("aria-selected", suffixMode ? "false" : "true");
  saveSuffixInput.disabled = !suffixMode;
  saveSuffixRemember.disabled = !suffixMode;
  saveSuffixDefault.disabled = !suffixMode || !saveSuffixRemember.checked;
  saveRenameInput.disabled = suffixMode;
  if (!saveSuffixRemember.checked) saveSuffixDefault.checked = false;
  saveNamePreview.textContent = buildOutputName(currentFile?.name || "image.png", readSaveNameConfig());
}

function readSaveNameConfig() {
  return {
    mode: saveNameModeRename.checked ? "rename" : "suffix",
    suffix: sanitizeFilenamePart(saveSuffixInput.value),
    rememberSuffix: saveSuffixRemember.checked,
    setDefaultSuffix: saveSuffixDefault.checked,
    renameBase: sanitizeFilenamePart(saveRenameInput.value),
    randomSuffix: pendingSaveRandomSuffix || buildRandomSuffix(),
  };
}

async function persistSaveNameConfig(config) {
  appConfig.saveNameMode = config.mode;
  if (config.mode !== "suffix") return saveAppConfig();
  const cleanSuffix = config.suffix || appConfig.defaultSaveSuffix || "ieditor";
  if (config.rememberSuffix) {
    appConfig.saveSuffixOptions = Array.from(new Set([cleanSuffix, ...appConfig.saveSuffixOptions])).slice(0, 50);
  }
  if (config.setDefaultSuffix) {
    appConfig.defaultSaveSuffix = cleanSuffix;
    if (!appConfig.saveSuffixOptions.includes(cleanSuffix)) {
      appConfig.saveSuffixOptions = [cleanSuffix, ...appConfig.saveSuffixOptions].slice(0, 50);
    }
  }
  return saveAppConfig();
}

async function saveInfoFieldNames() {
  const custom = infoFieldNames.filter((name) => !defaultInfoFieldNames.includes(name));
  appConfig.customInfoFieldNames = custom;
  await saveAppConfig();
}

function collectRows() {
  return metadataRows
    .map((row) => ({ key: String(row.key || "").trim(), value: String(row.value || ""), source: row.source || "自定义" }))
    .filter((row) => row.key.length > 0);
}

function getRenderedFieldValue(value, rowIndex) {
  if (value.length <= appConfig.maxInlineValueLength) return { value, collapsed: false, isLong: false };
  if (expandedLongRows.has(rowIndex)) return { value, collapsed: false, isLong: true };
  return {
    value: `${value.slice(0, appConfig.collapsedPreviewLength)}\n\n... 已折叠 ${value.length - appConfig.collapsedPreviewLength} 个字符`,
    collapsed: true,
    isLong: true,
  };
}

function buildRowsStatus() {
  if (metadataRows.length <= visibleRowLimit) return `已读取 ${metadataRows.length} 个元数据字段`;
  return `已读取 ${metadataRows.length} 个元数据字段，当前显示 ${visibleRowLimit} 个`;
}

function exportFieldValue(rowIndex) {
  const row = metadataRows[rowIndex];
  const exportInfo = detectExportableValue(row.value || "", { includeBytes: true });
  if (!exportInfo) return setStatus("该字段没有可导出的内容", false);
  downloadBytes(exportInfo.bytes, buildFieldExportName(row.key, exportInfo.extension), exportInfo.mime);
  setStatus(`已导出 ${exportInfo.label} 文件`, true);
}

const textExportFormats = [
  { extension: "json", mime: "application/json", label: "JSON", test: isJsonText },
  { extension: "svg", mime: "image/svg+xml", label: "SVG", test: isSvgText },
  { extension: "html", mime: "text/html", label: "HTML", test: isHtmlText },
  { extension: "xml", mime: "application/xml", label: "XML", test: isXmlText },
  { extension: "css", mime: "text/css", label: "CSS", test: isCssText },
  { extension: "js", mime: "text/javascript", label: "JS", test: isJavaScriptText },
  { extension: "csv", mime: "text/csv", label: "CSV", test: isCsvText },
];
const txtExportFormat = { extension: "txt", mime: "text/plain;charset=utf-8", label: "TXT" };

function detectExportableValue(value, options = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const dataUrl = parseDataUrl(trimmed, options.includeBytes);
  if (dataUrl) return dataUrl;
  const base64File = parseBase64File(trimmed, options.includeBytes);
  if (base64File) return base64File;
  const format = textExportFormats.find((item) => item.test(trimmed)) || txtExportFormat;
  return { ...format, bytes: options.includeBytes ? textEncoder.encode(trimmed) : null };
}

function getCachedExportInfo(row) {
  const value = row.value || "";
  const cached = exportInfoCache.get(row);
  if (cached && cached.value === value) return cached.info;
  const info = detectExportableValue(value);
  exportInfoCache.set(row, { value, info });
  return info;
}

function isJsonText(value) {
  if (!/^[\[{]/.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isSvgText(value) {
  return /^<svg(?:\s|>)[\s\S]*<\/svg>\s*$/i.test(value);
}

function isHtmlText(value) {
  return /^(<!doctype\s+html\s*>[\s\S]*<html(?:\s|>)|<html(?:\s|>)[\s\S]*<\/html>\s*$)/i.test(value);
}

function isXmlText(value) {
  if (!/^<\?xml[\s\S]*\?>\s*</i.test(value) && !/^<[a-z_][\w:.-]*(?:\s[^>]*)?>/i.test(value)) return false;
  if (isSvgText(value) || isHtmlText(value)) return false;
  const match = value.match(/^(?:<\?xml[\s\S]*?\?>\s*)?<([a-z_][\w:.-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/i);
  return Boolean(match);
}

function isCssText(value) {
  if (/^[<{[]/.test(value) || isJsonText(value)) return false;
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!withoutComments.includes("{") || !withoutComments.includes("}")) return false;
  if (!hasBalancedCssBraces(withoutComments)) return false;

  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  let remainder = withoutComments;
  let hasRule = false;
  let match;
  while ((match = rulePattern.exec(withoutComments))) {
    const selector = match[1].trim();
    const body = match[2].trim();
    if (!selector || selector.startsWith("{") || selector.startsWith("[") || selector.includes('"')) return false;
    if (!/[.#\w*:[\]=>~+),-]/.test(selector)) return false;
    if (!body.split(";").some(hasCssDeclaration)) return false;
    remainder = remainder.replace(match[0], "");
    hasRule = true;
  }
  return hasRule && remainder.trim() === "";
}

function hasCssDeclaration(part) {
  const declaration = part.trim();
  const separator = declaration.indexOf(":");
  if (separator <= 0) return false;
  const property = declaration.slice(0, separator).trim();
  const propertyValue = declaration.slice(separator + 1).trim();
  return /^-{0,2}[\w-]+$/.test(property) && propertyValue.length > 0;
}

function hasBalancedCssBraces(value) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quote;
}

function isJavaScriptText(value) {
  if (/^[<{[]/.test(value)) return false;
  return /\b(import|export|function|class|const|let|var|async\s+function)\b|=>/.test(value);
}

function isCsvText(value) {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return false;
  const delimiter = value.includes("\t") && !value.includes(",") ? "\t" : ",";
  const widths = lines.map((line) => splitDelimitedLine(line, delimiter).length);
  return widths[0] > 1 && widths.every((width) => width === widths[0]);
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseDataUrl(value, includeBytes) {
  const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const extension = extensionFromMime(mime);
  try {
    return { label: extension.toUpperCase(), extension, mime, bytes: includeBytes ? (match[2] ? base64ToBytes(match[3]) : textEncoder.encode(decodeURIComponent(match[3]))) : null };
  } catch {
    return null;
  }
}

function parseBase64File(value, includeBytes) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 24 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const signature = detectBinarySignature(base64ToBytes(compact.slice(0, 64)));
    if (!signature) return null;
    return { ...signature, bytes: includeBytes ? base64ToBytes(compact) : null };
  } catch {
    return null;
  }
}

function detectBinarySignature(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { label: "PNG", extension: "png", mime: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { label: "JPEG", extension: "jpg", mime: "image/jpeg" };
  if (asciiFromBytes(bytes.slice(0, 4)) === "GIF8") return { label: "GIF", extension: "gif", mime: "image/gif" };
  if (asciiFromBytes(bytes.slice(0, 4)) === "%PDF") return { label: "PDF", extension: "pdf", mime: "application/pdf" };
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { label: "ZIP", extension: "zip", mime: "application/zip" };
  if (asciiFromBytes(bytes.slice(0, 4)) === "RIFF" && asciiFromBytes(bytes.slice(8, 12)) === "WEBP") return { label: "WEBP", extension: "webp", mime: "image/webp" };
  return null;
}

function buildOutputName(name, config = {}) {
  const ext = fileExtension(name);
  const base = fileBaseName(name);
  const random = config.randomSuffix || buildRandomSuffix();
  if (config.mode === "rename") {
    const renameBase = sanitizeFilenamePart(config.renameBase) || base || "image";
    return `${renameBase}-${random}${ext}`;
  }
  const suffix = sanitizeFilenamePart(config.suffix) || appConfig.defaultSaveSuffix || "ieditor";
  return `${joinFilenameParts([base || "image", suffix, random])}${ext}`;
}

function buildFieldExportName(key, extension) {
  const base = String(key || "metadata-field").trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "metadata-field"}.${extension}`;
}

function fileBaseName(name) {
  const cleanName = String(name || "").trim();
  const dot = cleanName.lastIndexOf(".");
  return sanitizeFilenamePart(dot === -1 ? cleanName : cleanName.slice(0, dot)) || "image";
}

function fileExtension(name) {
  const cleanName = String(name || "").trim();
  const dot = cleanName.lastIndexOf(".");
  return dot === -1 ? "" : cleanName.slice(dot);
}

function joinFilenameParts(parts) {
  return parts.filter(Boolean).join("-");
}

function buildRandomSuffix() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let index = 0; index < 4; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
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

function filenameFromUrl(url, type) {
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
  } catch {}
  const extension = extensionFromType(type);
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) return `url-image.${extension}`;
  return /\.(png|jpe?g|jfif|webp|avif)$/i.test(clean) ? clean : `${clean}.${extension}`;
}

function extensionFromType(type) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" })[type] || "bin";
}

function extensionFromMime(mime) {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/json": "json",
    "application/pdf": "pdf",
    "application/xml": "xml",
    "text/plain": "txt",
    "text/html": "html",
    "text/css": "css",
    "text/javascript": "js",
    "text/csv": "csv",
    "application/zip": "zip",
  };
  return map[String(mime).toLowerCase()] || "bin";
}

function downloadBytes(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function setStatus(message, ready) {
  statusText.textContent = message;
  statusDot.classList.toggle("ready", Boolean(ready));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function estimateDataUrlBytes(payload, base64) {
  if (!base64) return payload.length;
  const compact = payload.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function asciiFromBytes(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
