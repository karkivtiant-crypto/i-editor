const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

const exifTagNames = {
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x8298: "Copyright",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9286: "UserComment",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
};

export function normalizeImageType(type, name = "") {
  const normalized = String(type || "").toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg";
  if (normalized) return normalized;
  const lower = name.toLowerCase().split(/[?#]/)[0];
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".jfif")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  return "";
}

export async function readMetadata(bytes, type) {
  if (type === "image/png") return readPngMetadata(bytes);
  if (type === "image/jpeg") return readJpegMetadata(bytes);
  if (type === "image/webp") return readWebpMetadata(bytes);
  if (type === "image/avif") return readAvifMetadata(bytes);
  return [];
}

export async function writeImageMetadata(bytes, type, rows) {
  if (type === "image/png") return writePngMetadata(bytes, rows);
  if (type === "image/jpeg") return writeJpegMetadata(bytes, rows);
  if (type === "image/webp") return writeWebpMetadata(bytes, rows);
  throw new Error("当前格式只支持读取，暂不支持写入保存");
}

export function buildWritePreview(type, rows) {
  const xmp = buildXmp(rows);
  return [
    `格式：${type}`,
    `字段数量：${rows.length}`,
    "",
    "将写入的字段：",
    ...rows.map((row) => `- ${row.key}: ${truncate(row.value, 220)}`),
    "",
    "XMP 预览：",
    truncate(xmp, 3000),
  ].join("\n");
}

function readJpegMetadata(bytes) {
  const rows = [];
  for (const segment of readJpegSegments(bytes)) {
    if (segment.marker !== 0xe1) continue;
    const payload = bytes.slice(segment.dataStart, segment.dataEnd);
    if (startsWithAscii(payload, "Exif\0\0")) {
      rows.push(...readExifPayload(payload.slice(6), "EXIF"));
    } else if (startsWithAscii(payload, "http://ns.adobe.com/xap/1.0/\0")) {
      rows.push(...xmpToRows(textDecoder.decode(payload.slice(29))));
    }
  }
  rows.push(...scanXmpRows(bytes));
  return mergeRows(rows);
}

function readJpegSegments(bytes) {
  const segments = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return segments;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) break;
    const dataStart = offset + 4;
    const dataEnd = offset + 2 + length;
    if (dataEnd > bytes.length) break;
    segments.push({ marker, start: offset, end: dataEnd, dataStart, dataEnd });
    offset = dataEnd;
  }
  return segments;
}

function writeJpegMetadata(bytes, rows) {
  const payload = concatBytes(asciiBytes("http://ns.adobe.com/xap/1.0/\0"), textEncoder.encode(buildXmp(rows)));
  if (payload.length + 2 > 65535) throw new Error("元数据太大，JPEG APP1 段无法保存");
  const segment = createJpegSegment(0xe1, payload);
  const existing = readJpegSegments(bytes).find((item) => {
    if (item.marker !== 0xe1) return false;
    const payloadStart = bytes.slice(item.dataStart, item.dataEnd);
    return startsWithAscii(payloadStart, "http://ns.adobe.com/xap/1.0/\0");
  });
  if (existing) return concatBytes(bytes.slice(0, existing.start), segment, bytes.slice(existing.end));
  return concatBytes(bytes.slice(0, 2), segment, bytes.slice(2));
}

function createJpegSegment(marker, payload) {
  const segment = new Uint8Array(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = marker;
  const length = payload.length + 2;
  segment[2] = (length >> 8) & 0xff;
  segment[3] = length & 0xff;
  segment.set(payload, 4);
  return segment;
}

async function readPngMetadata(bytes) {
  const rows = [];
  if (!isPng(bytes)) return rows;
  for (const chunk of readPngChunks(bytes)) {
    const data = bytes.slice(chunk.dataStart, chunk.dataEnd);
    if (chunk.type === "tEXt") {
      const zero = data.indexOf(0);
      if (zero > -1) rows.push({ key: latin1FromBytes(data.slice(0, zero)), value: latin1FromBytes(data.slice(zero + 1)), source: "PNG" });
    } else if (chunk.type === "iTXt") {
      const parsed = parseItxt(data);
      if (parsed) rows.push({ key: parsed.key, value: parsed.value, source: "PNG" });
    } else if (chunk.type === "zTXt") {
      const parsed = await parseZtxt(data);
      if (parsed) rows.push({ key: parsed.key, value: parsed.value, source: "PNG-zTXt" });
    } else if (chunk.type === "eXIf") {
      rows.push(...readExifPayload(data, "PNG-EXIF"));
    }
  }
  return mergeRows(rows);
}

function readPngChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = asciiFromBytes(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) break;
    chunks.push({ type, start: offset, end, dataStart, dataEnd });
    offset = end;
  }
  return chunks;
}

function writePngMetadata(bytes, rows) {
  if (!isPng(bytes)) throw new Error("PNG 文件结构无效");
  const chunks = [bytes.slice(0, 8)];
  let inserted = false;
  for (const chunk of readPngChunks(bytes)) {
    if (!["tEXt", "iTXt", "zTXt"].includes(chunk.type)) {
      if (chunk.type === "IEND" && !inserted) {
        rows.forEach((row) => chunks.push(createPngTextChunk(row.key, row.value)));
        inserted = true;
      }
      chunks.push(bytes.slice(chunk.start, chunk.end));
    }
  }
  return concatBytes(...chunks);
}

function createPngTextChunk(key, value) {
  const safeKey = key.replace(/\0/g, "").slice(0, 79) || "Metadata";
  const data = concatBytes(latin1Bytes(safeKey), new Uint8Array([0, 0, 0, 0, 0]), textEncoder.encode(value));
  const type = asciiBytes("iTXt");
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(concatBytes(type, data)));
  return chunk;
}

function readWebpMetadata(bytes) {
  const rows = [];
  for (const chunk of readWebpChunks(bytes)) {
    const data = bytes.slice(chunk.dataStart, chunk.dataEnd);
    if (chunk.type === "EXIF") rows.push(...readExifPayload(stripExifHeader(data), "WEBP-EXIF"));
    if (chunk.type === "XMP ") rows.push(...xmpToRows(textDecoder.decode(data)));
  }
  rows.push(...scanXmpRows(bytes));
  return mergeRows(rows);
}

function writeWebpMetadata(bytes, rows) {
  if (asciiFromBytes(bytes.slice(0, 4)) !== "RIFF" || asciiFromBytes(bytes.slice(8, 12)) !== "WEBP") {
    throw new Error("WebP 文件结构无效");
  }
  const xmp = textEncoder.encode(buildXmp(rows));
  const newChunk = createRiffChunk("XMP ", xmp);
  const parts = [bytes.slice(0, 12)];
  let replaced = false;
  for (const chunk of readWebpChunks(bytes)) {
    if (chunk.type === "XMP ") {
      if (!replaced) parts.push(newChunk);
      replaced = true;
    } else {
      parts.push(bytes.slice(chunk.start, chunk.end));
    }
  }
  if (!replaced) parts.push(newChunk);
  const out = concatBytes(...parts);
  writeUint32LE(out, 4, out.length - 8);
  return out;
}

function readWebpChunks(bytes) {
  const chunks = [];
  if (asciiFromBytes(bytes.slice(0, 4)) !== "RIFF" || asciiFromBytes(bytes.slice(8, 12)) !== "WEBP") return chunks;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = asciiFromBytes(bytes.slice(offset, offset + 4));
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const end = dataEnd + (size % 2);
    if (dataEnd > bytes.length) break;
    chunks.push({ type, start: offset, end, dataStart, dataEnd });
    offset = end;
  }
  return chunks;
}

function createRiffChunk(type, data) {
  const pad = data.length % 2;
  const chunk = new Uint8Array(8 + data.length + pad);
  chunk.set(asciiBytes(type), 0);
  writeUint32LE(chunk, 4, data.length);
  chunk.set(data, 8);
  return chunk;
}

function readAvifMetadata(bytes) {
  const rows = [];
  rows.push(...scanXmpRows(bytes));
  const exifIndex = indexOfBytes(bytes, asciiBytes("Exif\0\0"));
  if (exifIndex !== -1) rows.push(...readExifPayload(bytes.slice(exifIndex + 6), "AVIF-EXIF"));
  return mergeRows(rows);
}

function readExifPayload(tiff, source) {
  const rows = [];
  if (tiff.length < 8) return rows;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const read16 = (o) => (little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const read32 = (o) => little
    ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
    : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;
  const visited = new Set();
  function readIfd(offset) {
    if (visited.has(offset) || offset + 2 > tiff.length) return;
    visited.add(offset);
    const count = read16(offset);
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > tiff.length) continue;
      const tag = read16(entry);
      const type = read16(entry + 2);
      const countValue = read32(entry + 4);
      const value = readExifValue(tiff, type, countValue, entry + 8, read16, read32);
      if ((tag === 0x8769 || tag === 0x8825) && typeof value === "number") {
        readIfd(value);
      } else if (value !== "") {
        rows.push({ key: exifTagNames[tag] || `EXIF_0x${tag.toString(16).padStart(4, "0")}`, value: String(value), source });
      }
    }
  }
  readIfd(read32(4));
  return rows;
}

function readExifValue(tiff, type, count, valueOffset, read16, read32) {
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const size = (sizes[type] || 0) * count;
  const offset = size <= 4 ? valueOffset : read32(valueOffset);
  if (offset < 0 || offset + size > tiff.length) return "";
  if (type === 2) return decodeExifText(tiff.slice(offset, offset + count));
  if (type === 7) return decodeExifText(tiff.slice(offset, offset + count));
  if (type === 3) return count === 1 ? read16(offset) : Array.from({ length: count }, (_, i) => read16(offset + i * 2)).join(", ");
  if (type === 4 || type === 9) return count === 1 ? read32(offset) : Array.from({ length: count }, (_, i) => read32(offset + i * 4)).join(", ");
  if (type === 5 || type === 10) {
    const values = Array.from({ length: count }, (_, i) => {
      const n = read32(offset + i * 8);
      const d = read32(offset + i * 8 + 4);
      return d ? `${n / d}` : `${n}/0`;
    });
    return count === 1 ? values[0] : values.join(", ");
  }
  return Array.from(tiff.slice(offset, offset + Math.min(size, 64))).join(", ");
}

function decodeExifText(bytes) {
  if (bytes.length === 0) return "";

  const prefix = asciiFromBytes(bytes.slice(0, Math.min(8, bytes.length)));
  if (prefix.startsWith("ASCII")) {
    return decodeLikelyText(bytes.slice(8));
  }
  if (prefix.startsWith("UNICODE")) {
    return decodeUtf16Payload(bytes.slice(8));
  }
  if (prefix.startsWith("JIS")) {
    return decodeLikelyText(bytes.slice(8));
  }

  return decodeLikelyText(bytes);
}

function decodeUtf16Payload(bytes) {
  const data = trimUtf16NullBytes(bytes);
  if (data.length === 0) return "";

  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.slice(2)).replace(/\0+$/g, "");
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.slice(2)).replace(/\0+$/g, "");
  }

  return new TextDecoder(guessUtf16Endian(data)).decode(data).replace(/\0+$/g, "");
}

function decodeLikelyText(bytes) {
  const data = trimTrailingNullBytes(bytes);
  if (data.length === 0) return "";

  const zeroOdd = countZeroBytes(data, 1);
  const zeroEven = countZeroBytes(data, 0);
  const half = Math.max(1, Math.floor(data.length / 2));

  if (zeroOdd > half * 0.35 || zeroEven > half * 0.35) {
    return new TextDecoder(guessUtf16Endian(data)).decode(data).replace(/\0+$/g, "");
  }

  return textDecoder.decode(data).replace(/\0+$/g, "");
}

function trimUtf16NullBytes(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start + 1 < end && bytes[start] === 0 && bytes[start + 1] === 0) start += 2;
  while (end - 2 >= start && bytes[end - 2] === 0 && bytes[end - 1] === 0) end -= 2;
  if ((end - start) % 2 === 1) end -= 1;
  return bytes.slice(start, end);
}

function guessUtf16Endian(bytes) {
  const zeroOdd = countZeroBytes(bytes, 1);
  const zeroEven = countZeroBytes(bytes, 0);
  return zeroOdd >= zeroEven ? "utf-16le" : "utf-16be";
}

function countZeroBytes(bytes, start) {
  let count = 0;
  for (let index = start; index < bytes.length; index += 2) {
    if (bytes[index] === 0) count += 1;
  }
  return count;
}

function trimTrailingNullBytes(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.slice(0, end);
}


function parseItxt(data) {
  const zero = data.indexOf(0);
  if (zero === -1) return null;
  const key = latin1FromBytes(data.slice(0, zero));
  const compressed = data[zero + 1] === 1;
  if (compressed) return null;
  const textStart = findItxtTextStart(data, zero + 1);
  return { key, value: textDecoder.decode(data.slice(textStart)) };
}

async function parseZtxt(data) {
  const zero = data.indexOf(0);
  if (zero === -1 || data[zero + 1] !== 0) return null;
  const key = latin1FromBytes(data.slice(0, zero));
  const compressed = data.slice(zero + 2);
  const value = await inflateBytes(compressed);
  return value == null ? null : { key, value };
}

async function inflateBytes(bytes) {
  if (typeof DecompressionStream !== "function") return "[zTXt 压缩内容：当前浏览器不支持解压]";
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    const buffer = await new Response(stream).arrayBuffer();
    return textDecoder.decode(buffer);
  } catch {
    return null;
  }
}

function xmpToRows(xml) {
  const rows = [];
  const custom = /<i-editor:field\s+name="([^"]*)">([\s\S]*?)<\/i-editor:field>/g;
  let match = custom.exec(xml);
  while (match) {
    rows.push({ key: xmlUnescape(match[1]), value: xmlUnescape(match[2]), source: "XMP" });
    match = custom.exec(xml);
  }
  const attrs = [
    ["xmp:CreatorTool", /xmp:CreatorTool="([^"]+)"/],
    ["xmp:CreateDate", /xmp:CreateDate="([^"]+)"/],
    ["xmp:ModifyDate", /xmp:ModifyDate="([^"]+)"/],
    ["dc:description", /<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:description>/],
    ["dc:title", /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:title>/],
    ["photoshop:Source", /photoshop:Source="([^"]+)"/],
  ];
  attrs.forEach(([key, regex]) => {
    const found = xml.match(regex);
    if (found) rows.push({ key, value: xmlUnescape(found[1]), source: "XMP" });
  });
  return rows;
}

function scanXmpRows(bytes) {
  const text = textDecoder.decode(bytes.slice(0, Math.min(bytes.length, 2_000_000)));
  const rows = [];
  const start = text.search(/<x:xmpmeta|<\?xpacket/);
  if (start === -1) return rows;
  const endTag = text.indexOf("</x:xmpmeta>", start);
  const packetEnd = text.indexOf("<?xpacket end=", start);
  const end = endTag !== -1 ? endTag + 12 : packetEnd !== -1 ? packetEnd + 60 : Math.min(text.length, start + 200000);
  return xmpToRows(text.slice(start, end));
}

function buildXmp(rows) {
  const fields = buildXmpFields(rows);
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:i-editor="https://local/i-editor/metadata/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="">${fields}</rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function buildXmpFields(rows) {
  return rows
    .map((row) => `<i-editor:field name="${xmlEscape(row.key)}">${xmlEscape(row.value)}</i-editor:field>`)
    .join("");
}

function stripExifHeader(data) {
  return startsWithAscii(data, "Exif\0\0") ? data.slice(6) : data;
}

function findItxtTextStart(data, offset) {
  let cursor = offset + 2;
  for (let i = 0; i < 2; i += 1) {
    while (cursor < data.length && data[cursor] !== 0) cursor += 1;
    cursor += 1;
  }
  return Math.min(cursor, data.length);
}

function mergeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = `${row.key}\0${row.value}\0${row.source}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function startsWithAscii(bytes, value) {
  const expected = asciiBytes(value);
  if (bytes.length < expected.length) return false;
  return expected.every((byte, index) => bytes[index] === byte);
}

function indexOfBytes(bytes, pattern) {
  outer: for (let i = 0; i <= bytes.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function asciiBytes(value) {
  return Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
}

function latin1Bytes(value) {
  return Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
}

function latin1FromBytes(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function asciiFromBytes(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function readUint32(bytes, offset) {
  return (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlUnescape(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}
