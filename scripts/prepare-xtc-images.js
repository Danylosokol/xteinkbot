import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import PImage from "pureimage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CONFIG = {
  inputEpubPath: path.join(projectRoot, "ddd.epub"),
  outputXtchPath: path.join(projectRoot, "ddd.hybrid-pages.xtch"),
  deviceWidth: 480,
  deviceHeight: 800,
  pageMarginX: 28,
  pageMarginTop: 34,
  pageMarginBottom: 38,
  fontSize: 26,
  lineHeight: 34,
  paragraphSpacing: 18,
  headingSpacing: 26,
  fontFamily: "ArialUnicodeXteink",
  fontPath: "/Library/Fonts/Arial Unicode.ttf",
  metadataTitleFallback: "EPUB Book",
  metadataAuthorFallback: "Unknown"
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true
});

await loadFont();

async function main() {
  await ensureFileExists(CONFIG.inputEpubPath);

  const zip = new AdmZip(CONFIG.inputEpubPath);
  const containerXml = readZipText(zip, "META-INF/container.xml");
  const opfRelativePath = resolveOpfPath(containerXml);
  const opfDirectory = path.posix.dirname(opfRelativePath);
  const opf = parseOpf(readZipText(zip, opfRelativePath));
  const pageBuffers = [];
  const textPaginator = createTextPaginator();

  for (const spineId of opf.spineRefs) {
    const manifestItem = opf.manifestById.get(spineId);

    if (!manifestItem?.href) {
      continue;
    }

    if (!/application\/xhtml\+xml|text\/html/i.test(manifestItem.mediaType || "")) {
      continue;
    }

    const contentZipPath = resolveZipPath(opfDirectory, manifestItem.href);
    const xhtml = readZipText(zip, contentZipPath);
    const tokens = extractFlowTokens(xhtml, path.posix.dirname(contentZipPath));

    for (const token of tokens) {
      if (token.type === "text") {
        textPaginator.pushText(token.text);
        continue;
      }

      if (token.type === "paragraph-break") {
        textPaginator.pushParagraphBreak(token.kind);
        continue;
      }

      if (token.type === "image") {
        const flushedPages = textPaginator.flushCurrentPage();
        pageBuffers.push(...flushedPages.map(encodeTextPage));

        const imageBuffer = readZipBinary(zip, token.zipPath);
        const decoded = decodeImage(imageBuffer, token.zipPath);
        const rotatedPage = renderLandscapePage(decoded, CONFIG.deviceWidth, CONFIG.deviceHeight);
        pageBuffers.push(encodeXth(rotatedPage.width, rotatedPage.height, rotatedPage.pixels));
      }
    }

    textPaginator.pushParagraphBreak("chapter");
  }

  pageBuffers.push(...textPaginator.finish().map(encodeTextPage));

  if (pageBuffers.length === 0) {
    throw new Error("No text or image pages were produced from the EPUB.");
  }

  const xtchBuffer = encodeXtch({
    pages: pageBuffers,
    title: opf.metadata.title || CONFIG.metadataTitleFallback,
    author: opf.metadata.author || CONFIG.metadataAuthorFallback,
    publisher: opf.metadata.publisher || "",
    language: opf.metadata.language || "en",
    createdAtUnix: Math.floor(Date.now() / 1000)
  });

  await fs.writeFile(CONFIG.outputXtchPath, xtchBuffer);

  console.log(`Created: ${CONFIG.outputXtchPath}`);
  console.log(`Pages written: ${pageBuffers.length}`);
}

async function loadFont() {
  await ensureFileExists(CONFIG.fontPath);
  const font = PImage.registerFont(CONFIG.fontPath, CONFIG.fontFamily);
  await font.load();
}

async function ensureFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing file: ${filePath}`);
  }
}

function readZipText(zip, zipPath) {
  const entry = zip.getEntry(zipPath);

  if (!entry) {
    throw new Error(`Missing ZIP entry: ${zipPath}`);
  }

  return zip.readAsText(entry, "utf8");
}

function readZipBinary(zip, zipPath) {
  const entry = zip.getEntry(zipPath);

  if (!entry) {
    throw new Error(`Missing ZIP entry: ${zipPath}`);
  }

  return zip.readFile(entry);
}

function resolveOpfPath(containerXml) {
  const parsed = xmlParser.parse(containerXml);
  const rootfiles = parsed.container?.rootfiles?.rootfile;
  const firstRootfile = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const fullPath = firstRootfile?.["full-path"];

  if (!fullPath) {
    throw new Error("Could not resolve OPF path from META-INF/container.xml.");
  }

  return fullPath;
}

function parseOpf(opfXml) {
  const parsed = xmlParser.parse(opfXml);
  const pkg = parsed.package;

  if (!pkg) {
    throw new Error("Invalid OPF package document.");
  }

  const manifestItems = normalizeArray(pkg.manifest?.item).map((item) => ({
    id: item.id,
    href: item.href,
    mediaType: item["media-type"]
  }));

  const manifestById = new Map(manifestItems.map((item) => [item.id, item]));
  const spineRefs = normalizeArray(pkg.spine?.itemref).map((itemref) => itemref.idref).filter(Boolean);
  const metadata = extractMetadata(pkg.metadata);

  return {
    manifestById,
    spineRefs,
    metadata
  };
}

function extractMetadata(metadataNode) {
  const title = firstText(metadataNode?.title);
  const author = firstText(metadataNode?.creator);
  const publisher = firstText(metadataNode?.publisher);
  const language = firstText(metadataNode?.language);

  return { title, author, publisher, language };
}

function firstText(node) {
  const first = normalizeArray(node)[0];

  if (!first) {
    return "";
  }

  if (typeof first === "string") {
    return first.trim();
  }

  if (typeof first === "object" && typeof first["#text"] === "string") {
    return first["#text"].trim();
  }

  return "";
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function extractFlowTokens(xhtml, baseDirectory) {
  const body = extractBody(xhtml);
  const tokens = [];
  const tagOrTextPattern = /(<[^>]+>|[^<]+)/g;
  let match;
  let skipDepth = 0;

  while ((match = tagOrTextPattern.exec(body)) !== null) {
    const part = match[0];

    if (part.startsWith("<")) {
      const tag = parseTag(part);

      if (!tag) {
        continue;
      }

      if (!tag.isClosing && (tag.name === "script" || tag.name === "style")) {
        skipDepth += 1;
        continue;
      }

      if (tag.isClosing && (tag.name === "script" || tag.name === "style")) {
        skipDepth = Math.max(0, skipDepth - 1);
        continue;
      }

      if (skipDepth > 0) {
        continue;
      }

      if (!tag.isClosing && tag.name === "img") {
        const src = tag.attributes.src;

        if (src) {
          tokens.push({
            type: "image",
            zipPath: resolveZipPath(baseDirectory, src)
          });
        }
        continue;
      }

      if (tag.name === "br") {
        tokens.push({ type: "paragraph-break", kind: "line" });
        continue;
      }

      if (BLOCK_BREAK_TAGS.has(tag.name) && (tag.isClosing || tag.selfClosing)) {
        tokens.push({
          type: "paragraph-break",
          kind: HEADING_TAGS.has(tag.name) ? "heading" : "paragraph"
        });
      }

      continue;
    }

    if (skipDepth > 0) {
      continue;
    }

    const decoded = decodeHtmlEntities(part);
    const normalized = normalizeWhitespace(decoded);

    if (normalized) {
      tokens.push({ type: "text", text: normalized });
    }
  }

  return compactBreaks(tokens);
}

const BLOCK_BREAK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "blockquote",
  "header",
  "footer",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function extractBody(xhtml) {
  const match = xhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : xhtml;
}

function parseTag(rawTag) {
  const match = rawTag.match(/^<\s*(\/)?\s*([a-zA-Z0-9:_-]+)([\s\S]*?)(\/?)\s*>$/);

  if (!match) {
    return null;
  }

  const [, closingSlash, rawName, attrText, selfClosingSlash] = match;
  const name = rawName.toLowerCase();
  const attributes = {};
  const attrPattern = /([a-zA-Z0-9:_-]+)\s*=\s*(['"])(.*?)\2/g;
  let attrMatch;

  while ((attrMatch = attrPattern.exec(attrText)) !== null) {
    attributes[attrMatch[1].toLowerCase()] = attrMatch[3];
  }

  return {
    name,
    attributes,
    isClosing: Boolean(closingSlash),
    selfClosing: Boolean(selfClosingSlash)
  };
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function compactBreaks(tokens) {
  const compacted = [];

  for (const token of tokens) {
    const previous = compacted[compacted.length - 1];

    if (token.type === "paragraph-break") {
      if (!previous || previous.type === "paragraph-break") {
        continue;
      }
    }

    compacted.push(token);
  }

  while (compacted[0]?.type === "paragraph-break") {
    compacted.shift();
  }

  while (compacted.at(-1)?.type === "paragraph-break") {
    compacted.pop();
  }

  return compacted;
}

function resolveZipPath(baseDirectory, relativePath) {
  const joined = path.posix.join(baseDirectory || ".", relativePath);
  return path.posix.normalize(joined).replace(/^\.\//, "");
}

function decodeImage(buffer, zipPath) {
  if (/\.png$/i.test(zipPath)) {
    const png = PNG.sync.read(buffer);
    return {
      width: png.width,
      height: png.height,
      data: png.data
    };
  }

  if (/\.jpe?g$/i.test(zipPath)) {
    return jpeg.decode(buffer, { useTArray: true });
  }

  throw new Error(`Unsupported image format for ${zipPath}`);
}

function renderLandscapePage(decoded, portraitWidth, portraitHeight) {
  const landscapeWidth = portraitHeight;
  const landscapeHeight = portraitWidth;
  const landscapeCanvas = new Uint8Array(landscapeWidth * landscapeHeight);
  landscapeCanvas.fill(255);

  const fit = fitContain(decoded.width, decoded.height, landscapeWidth, landscapeHeight);
  blitScaledGrayscale(decoded, landscapeCanvas, {
    canvasWidth: landscapeWidth,
    canvasHeight: landscapeHeight,
    targetX: fit.offsetX,
    targetY: fit.offsetY,
    targetWidth: fit.width,
    targetHeight: fit.height
  });

  const rotated = rotateLandscapeToPortraitClockwise(
    landscapeCanvas,
    landscapeWidth,
    landscapeHeight
  );

  return {
    width: portraitWidth,
    height: portraitHeight,
    pixels: rotated
  };
}

function fitContain(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  return {
    width,
    height,
    offsetX: Math.floor((targetWidth - width) / 2),
    offsetY: Math.floor((targetHeight - height) / 2)
  };
}

function blitScaledGrayscale(decoded, canvas, layout) {
  const {
    canvasWidth,
    targetX,
    targetY,
    targetWidth,
    targetHeight
  } = layout;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.floor((y / targetHeight) * decoded.height));

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor((x / targetWidth) * decoded.width));
      const rgbaIndex = (sourceY * decoded.width + sourceX) * 4;
      const gray = rgbaToGrayscale(
        decoded.data[rgbaIndex],
        decoded.data[rgbaIndex + 1],
        decoded.data[rgbaIndex + 2],
        decoded.data[rgbaIndex + 3]
      );
      const canvasIndex = (targetY + y) * canvasWidth + (targetX + x);
      canvas[canvasIndex] = gray;
    }
  }
}

function rgbaToGrayscale(r, g, b, a = 255) {
  const alpha = a / 255;
  const blendedR = 255 - (255 - r) * alpha;
  const blendedG = 255 - (255 - g) * alpha;
  const blendedB = 255 - (255 - b) * alpha;
  return Math.round(0.299 * blendedR + 0.587 * blendedG + 0.114 * blendedB);
}

function rotateLandscapeToPortraitClockwise(source, sourceWidth, sourceHeight) {
  const targetWidth = sourceHeight;
  const targetHeight = sourceWidth;
  const target = new Uint8Array(targetWidth * targetHeight);

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const targetX = sourceHeight - 1 - y;
      const targetY = x;
      target[targetY * targetWidth + targetX] = source[y * sourceWidth + x];
    }
  }

  return target;
}

function createTextPaginator() {
  const pages = [];
  let current = createTextPageState();

  function ensureLineCapacity(requiredHeight) {
    const bottomLimit = CONFIG.deviceHeight - CONFIG.pageMarginBottom;

    if (current.cursorY + requiredHeight <= bottomLimit) {
      return;
    }

    if (current.lines.length > 0) {
      pages.push(finalizeCurrentPage());
      current = createTextPageState();
    }
  }

  function finalizeCurrentPage() {
    const lines = current.lines.slice();
    return {
      lines
    };
  }

  return {
    pushText(text) {
      const words = text.split(" ").filter(Boolean);

      for (const word of words) {
        const candidate = current.currentLine ? `${current.currentLine} ${word}` : word;
        const candidateWidth = measureTextWidth(candidate);

        if (candidateWidth <= current.contentWidth) {
          current.currentLine = candidate;
          continue;
        }

        if (!current.currentLine) {
          current.currentLine = hardWrapWord(word, current.contentWidth)[0];
          const remaining = word.slice(current.currentLine.length);
          commitLine();

          if (remaining) {
            this.pushText(remaining);
          }
          continue;
        }

        commitLine();
        current.currentLine = word;
      }
    },
    pushParagraphBreak(kind) {
      if (kind === "line") {
        commitLine();
        return;
      }

      commitLine();
      const spacing = kind === "heading" ? CONFIG.headingSpacing : CONFIG.paragraphSpacing;

      if (current.lines.length > 0) {
        ensureLineCapacity(spacing);
        current.cursorY += spacing;
      }
    },
    flushCurrentPage() {
      commitLine();

      if (current.lines.length === 0) {
        return [];
      }

      pages.push(finalizeCurrentPage());
      current = createTextPageState();
      const result = pages.slice();
      pages.length = 0;
      return result;
    },
    finish() {
      commitLine();

      if (current.lines.length > 0) {
        pages.push(finalizeCurrentPage());
      }

      return pages.slice();
    }
  };

  function commitLine() {
    if (!current.currentLine) {
      return;
    }

    ensureLineCapacity(CONFIG.lineHeight);
    current.lines.push({
      x: CONFIG.pageMarginX,
      y: current.cursorY,
      text: current.currentLine
    });
    current.currentLine = "";
    current.cursorY += CONFIG.lineHeight;
  }
}

function createTextPageState() {
  return {
    lines: [],
    currentLine: "",
    cursorY: CONFIG.pageMarginTop + CONFIG.fontSize,
    contentWidth: CONFIG.deviceWidth - CONFIG.pageMarginX * 2
  };
}

function measureTextWidth(text) {
  const image = PImage.make(8, 8);
  const ctx = image.getContext("2d");
  ctx.font = `${CONFIG.fontSize}pt "${CONFIG.fontFamily}"`;
  return ctx.measureText(text).width;
}

function hardWrapWord(word, maxWidth) {
  const chunks = [];
  let current = "";

  for (const char of word) {
    const candidate = current + char;

    if (current && measureTextWidth(candidate) > maxWidth) {
      chunks.push(current);
      current = char;
      continue;
    }

    current = candidate;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [word];
}

function encodeTextPage(page) {
  const image = PImage.make(CONFIG.deviceWidth, CONFIG.deviceHeight);
  const ctx = image.getContext("2d");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, CONFIG.deviceWidth, CONFIG.deviceHeight);
  ctx.fillStyle = "black";
  ctx.font = `${CONFIG.fontSize}pt "${CONFIG.fontFamily}"`;

  for (const line of page.lines) {
    ctx.fillText(line.text, line.x, line.y);
  }

  return encodeXth(CONFIG.deviceWidth, CONFIG.deviceHeight, rgbaImageToGrayscale(image.data));
}

function rgbaImageToGrayscale(rgbaData) {
  const grayscale = new Uint8Array(rgbaData.length / 4);

  for (let i = 0; i < grayscale.length; i += 1) {
    const rgbaIndex = i * 4;
    grayscale[i] = rgbaToGrayscale(
      rgbaData[rgbaIndex],
      rgbaData[rgbaIndex + 1],
      rgbaData[rgbaIndex + 2],
      rgbaData[rgbaIndex + 3]
    );
  }

  return grayscale;
}

function encodeXth(width, height, grayscalePixels) {
  const planeSize = Math.ceil((width * height) / 8);
  const plane1 = Buffer.alloc(planeSize);
  const plane2 = Buffer.alloc(planeSize);

  let bitCursor = 0;

  for (let x = width - 1; x >= 0; x -= 1) {
    for (let yBase = 0; yBase < height; yBase += 8) {
      let byte1 = 0;
      let byte2 = 0;

      for (let bit = 0; bit < 8; bit += 1) {
        const y = yBase + bit;
        const pixelValue = y < height ? grayscaleToXteinkLevel(grayscalePixels[y * width + x]) : 0;
        const bit1 = (pixelValue >> 1) & 1;
        const bit2 = pixelValue & 1;
        byte1 |= bit1 << (7 - bit);
        byte2 |= bit2 << (7 - bit);
      }

      plane1[bitCursor] = byte1;
      plane2[bitCursor] = byte2;
      bitCursor += 1;
    }
  }

  const data = Buffer.concat([plane1, plane2]);
  const header = Buffer.alloc(22);
  header.write("XTH\0", 0, "ascii");
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt32LE(data.length, 10);

  const md5 = crypto.createHash("md5").update(data).digest().subarray(0, 8);
  md5.copy(header, 14);

  return Buffer.concat([header, data]);
}

function grayscaleToXteinkLevel(gray) {
  if (gray >= 224) {
    return 0;
  }

  if (gray >= 160) {
    return 2;
  }

  if (gray >= 96) {
    return 1;
  }

  return 3;
}

function encodeXtch({ pages, title, author, publisher, language, createdAtUnix }) {
  const pageCount = pages.length;
  const headerSize = 56;
  const metadataSize = 256;
  const indexEntrySize = 16;
  const indexSize = pageCount * indexEntrySize;
  const metadataOffset = headerSize;
  const indexOffset = metadataOffset + metadataSize;
  const dataOffset = indexOffset + indexSize;

  const metadata = Buffer.alloc(metadataSize);
  writeNullTerminatedUtf8(metadata, 0x00, 128, title);
  writeNullTerminatedUtf8(metadata, 0x80, 64, author);
  writeNullTerminatedUtf8(metadata, 0xC0, 32, publisher);
  writeNullTerminatedUtf8(metadata, 0xE0, 16, language);
  metadata.writeUInt32LE(createdAtUnix, 0xF0);

  const header = Buffer.alloc(headerSize);
  header.write("XTCH", 0, "ascii");
  header.writeUInt16LE(0x0100, 4);
  header.writeUInt16LE(pageCount, 6);
  header.writeUInt8(0, 8);
  header.writeUInt8(1, 9);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt32LE(1, 12);
  header.writeBigUInt64LE(BigInt(metadataOffset), 16);
  header.writeBigUInt64LE(BigInt(indexOffset), 24);
  header.writeBigUInt64LE(BigInt(dataOffset), 32);
  header.writeBigUInt64LE(0n, 40);
  header.writeBigUInt64LE(0n, 48);

  const index = Buffer.alloc(indexSize);
  const pageBuffers = [];
  let runningOffset = dataOffset;

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const entryOffset = i * indexEntrySize;

    index.writeBigUInt64LE(BigInt(runningOffset), entryOffset);
    index.writeUInt32LE(page.length, entryOffset + 8);
    index.writeUInt16LE(CONFIG.deviceWidth, entryOffset + 12);
    index.writeUInt16LE(CONFIG.deviceHeight, entryOffset + 14);

    pageBuffers.push(page);
    runningOffset += page.length;
  }

  return Buffer.concat([header, metadata, index, ...pageBuffers]);
}

function writeNullTerminatedUtf8(buffer, offset, maxLength, value) {
  const encoded = Buffer.from(value || "", "utf8");
  encoded.subarray(0, Math.max(0, maxLength - 1)).copy(buffer, offset);
  buffer[offset + Math.min(encoded.length, maxLength - 1)] = 0;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
