import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";
import yazl from "yazl";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true
});

export async function transformEpubBuffer(inputBuffer) {
  const zip = new AdmZip(inputBuffer);
  const entries = new Map();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    entries.set(normalizeZipPath(entry.entryName), zip.readFile(entry));
  }

  const containerXml = readTextEntry(entries, "META-INF/container.xml");
  const opfPath = resolveOpfPath(containerXml);
  const opfDirectory = path.posix.dirname(opfPath);
  const opfXml = readTextEntry(entries, opfPath);
  const manifestItems = parseManifestItems(opfXml);
  const spineIds = parseSpineIds(opfXml);
  const generatedCssPath = joinPosix(opfDirectory, "xteink-rotated-pages.css");

  entries.set(generatedCssPath, Buffer.from(buildGeneratedCss(), "utf8"));

  const generatedManifestItems = [
    createManifestItem({
      id: "xteink_rotated_pages_css",
      href: path.posix.basename(generatedCssPath),
      mediaType: "text/css"
    })
  ];
  const nextSpineIds = [];

  for (const spineId of spineIds) {
    const manifestItem = manifestItems.get(spineId);

    if (!manifestItem) {
      nextSpineIds.push(spineId);
      continue;
    }

    if (!/\.(xhtml|html|htm)$/i.test(manifestItem.href)) {
      nextSpineIds.push(spineId);
      continue;
    }

    const contentHref = normalizeZipPath(joinPosix(opfDirectory, manifestItem.href));
    const originalContent = readTextEntry(entries, contentHref);
    const rewriteResult = await rewriteContentDocument({
      content: originalContent,
      contentHref,
      opfDirectory,
      generatedCssPath,
      entries
    });

    if (!rewriteResult.changed) {
      nextSpineIds.push(spineId);
      continue;
    }

    generatedManifestItems.push(...rewriteResult.manifestEntries);
    nextSpineIds.push(...rewriteResult.spineIds);
  }

  const updatedOpfXml = updateOpf(opfXml, generatedManifestItems, nextSpineIds);
  entries.set(opfPath, Buffer.from(updatedOpfXml, "utf8"));

  return buildEpubBuffer(entries);
}

async function rewriteContentDocument({ content, contentHref, opfDirectory, generatedCssPath, entries }) {
  const split = splitContentAroundImages(content);

  if (!split.changed) {
    return {
      changed: false,
      manifestEntries: [],
      spineIds: []
    };
  }

  const manifestEntries = [];
  const spineIds = [];
  const contentDirectory = path.posix.dirname(contentHref);
  const baseName = path.posix.basename(contentHref, path.posix.extname(contentHref));
  const idStem = sanitizeIdStem(contentHref);
  let textIndex = 1;
  let imageIndex = 1;

  for (const segment of split.segments) {
    if (segment.type === "text") {
      if (!hasMeaningfulMarkup(segment.bodyHtml)) {
        continue;
      }

      const href = joinPosix(contentDirectory, `${baseName}.xteink-text-${textIndex}.html`);
      const id = `${idStem}_xteink_text_${textIndex}`;
      const relativeCssHref = path.posix.relative(path.posix.dirname(href), generatedCssPath);
      const segmentHtml = buildTextDocument({
        template: split.template,
        bodyHtml: segment.bodyHtml,
        generatedCssHref: relativeCssHref
      });

      entries.set(href, Buffer.from(segmentHtml, "utf8"));
      manifestEntries.push(
        createManifestItem({
          id,
          href: path.posix.relative(opfDirectory, href),
          mediaType: "application/xhtml+xml"
        })
      );
      spineIds.push(id);
      textIndex += 1;
      continue;
    }

    const sourceImagePath = normalizeZipPath(joinPosix(contentDirectory, segment.src));
    const sourceImageBuffer = entries.get(sourceImagePath);

    if (!sourceImageBuffer) {
      continue;
    }

    const rotatedImagePath = buildRotatedImagePath(sourceImagePath, imageIndex);
    const rotatedImageBuffer = await sharp(sourceImageBuffer).rotate(90).toBuffer();
    entries.set(rotatedImagePath, rotatedImageBuffer);

    const imagePagePath = joinPosix(contentDirectory, `${baseName}.xteink-image-${imageIndex}.html`);
    const imagePageId = `${idStem}_xteink_image_${imageIndex}`;
    const imageManifestId = `${idStem}_xteink_image_asset_${imageIndex}`;
    const relativeImageHref = path.posix.relative(path.posix.dirname(imagePagePath), rotatedImagePath);
    const relativeCssHref = path.posix.relative(path.posix.dirname(imagePagePath), generatedCssPath);

    entries.set(
      imagePagePath,
      Buffer.from(
        buildImageDocument({
          template: split.template,
          generatedCssHref: relativeCssHref,
          imageHref: relativeImageHref,
          altText: segment.altText
        }),
        "utf8"
      )
    );

    manifestEntries.push(
      createManifestItem({
        id: imageManifestId,
        href: path.posix.relative(opfDirectory, rotatedImagePath),
        mediaType: inferImageMediaType(rotatedImagePath)
      })
    );
    manifestEntries.push(
      createManifestItem({
        id: imagePageId,
        href: path.posix.relative(opfDirectory, imagePagePath),
        mediaType: "application/xhtml+xml"
      })
    );
    spineIds.push(imagePageId);
    imageIndex += 1;
  }

  entries.delete(contentHref);

  return {
    changed: true,
    manifestEntries,
    spineIds
  };
}

function splitContentAroundImages(content) {
  const bodyMatch = content.match(/(<body\b[^>]*>)([\s\S]*?)(<\/body>)/i);

  if (!bodyMatch) {
    return { changed: false, segments: [], template: null };
  }

  const [, bodyOpenTag, bodyInnerHtml, bodyCloseTag] = bodyMatch;
  const prefix = content.slice(0, bodyMatch.index);
  const suffix = content.slice(bodyMatch.index + bodyMatch[0].length);
  const imageBlocks = findImageBlocks(bodyInnerHtml);

  if (imageBlocks.length === 0) {
    return { changed: false, segments: [], template: null };
  }

  const segments = [];
  let cursor = 0;

  for (const block of imageBlocks) {
    if (block.index > cursor) {
      segments.push({ type: "text", bodyHtml: bodyInnerHtml.slice(cursor, block.index) });
    }

    segments.push({
      type: "image",
      src: block.src,
      altText: block.altText
    });
    cursor = block.index + block.length;
  }

  if (cursor < bodyInnerHtml.length) {
    segments.push({ type: "text", bodyHtml: bodyInnerHtml.slice(cursor) });
  }

  return {
    changed: true,
    segments,
    template: {
      prefix,
      bodyOpenTag,
      bodyCloseTag,
      suffix
    }
  };
}

function findImageBlocks(bodyHtml) {
  const blocks = [];
  const blockPattern = /<(p|div)\b[^>]*>\s*<img\b([^>]*?)\/?>\s*<\/\1>/gi;
  let match;

  while ((match = blockPattern.exec(bodyHtml)) !== null) {
    const attrs = match[2];
    const src = readAttribute(attrs, "src");

    if (!src) {
      continue;
    }

    blocks.push({
      index: match.index,
      length: match[0].length,
      src,
      altText: readAttribute(attrs, "alt") || "Illustration"
    });
  }

  if (blocks.length > 0) {
    return blocks;
  }

  const inlinePattern = /<img\b([^>]*?)\/?>/gi;

  while ((match = inlinePattern.exec(bodyHtml)) !== null) {
    const attrs = match[1];
    const src = readAttribute(attrs, "src");

    if (!src) {
      continue;
    }

    blocks.push({
      index: match.index,
      length: match[0].length,
      src,
      altText: readAttribute(attrs, "alt") || "Illustration"
    });
  }

  return blocks;
}

function readAttribute(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, "i"));
  return match ? decodeEntities(match[2]) : "";
}

function hasMeaningfulMarkup(bodyHtml) {
  const stripped = decodeEntities(
    bodyHtml
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  return stripped.length > 0;
}

function buildTextDocument({ template, bodyHtml, generatedCssHref }) {
  return injectHeadLink(
    `${template.prefix}${template.bodyOpenTag}${bodyHtml}${template.bodyCloseTag}${template.suffix}`,
    generatedCssHref
  );
}

function buildImageDocument({ template, generatedCssHref, imageHref, altText }) {
  const bodyHtml = `
  <div class="xteink-image-page">
    <img class="xteink-image-page__image" src="${escapeHtml(imageHref)}" alt="${escapeHtml(altText)}" />
  </div>
`;

  return injectHeadLink(
    `${template.prefix}${template.bodyOpenTag}${bodyHtml}${template.bodyCloseTag}${template.suffix}`,
    generatedCssHref
  );
}

function injectHeadLink(content, href) {
  if (content.includes(href)) {
    return content;
  }

  const linkTag = `\n<link rel="stylesheet" type="text/css" href="${href}" />`;

  if (/<\/head>/i.test(content)) {
    return content.replace(/<\/head>/i, `${linkTag}\n</head>`);
  }

  return content;
}

function parseManifestItems(opfXml) {
  const items = new Map();
  const itemPattern = /<item\b([^>]*?)\/>/gi;
  let match;

  while ((match = itemPattern.exec(opfXml)) !== null) {
    const attrs = match[1];
    const id = readAttribute(attrs, "id");

    if (!id) {
      continue;
    }

    items.set(id, {
      id,
      href: readAttribute(attrs, "href"),
      mediaType: readAttribute(attrs, "media-type")
    });
  }

  return items;
}

function parseSpineIds(opfXml) {
  const spineMatch = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);

  if (!spineMatch) {
    return [];
  }

  const ids = [];
  const itemRefPattern = /<itemref\b([^>]*?)\/>/gi;
  let match;

  while ((match = itemRefPattern.exec(spineMatch[1])) !== null) {
    const idref = readAttribute(match[1], "idref");

    if (idref) {
      ids.push(idref);
    }
  }

  return ids;
}

function resolveOpfPath(containerXml) {
  const parsed = xmlParser.parse(containerXml);
  const rootfiles = parsed.container?.rootfiles?.rootfile;
  const firstRootfile = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const fullPath = firstRootfile?.["full-path"];

  if (!fullPath) {
    throw new Error("Could not resolve OPF path from container.xml");
  }

  return normalizeZipPath(fullPath);
}

function readTextEntry(entries, entryPath) {
  const buffer = entries.get(normalizeZipPath(entryPath));

  if (!buffer) {
    throw new Error(`Missing EPUB entry: ${entryPath}`);
  }

  return buffer.toString("utf8");
}

function buildRotatedImagePath(sourcePath, imageIndex) {
  const extension = path.posix.extname(sourcePath);
  const base = sourcePath.slice(0, -extension.length);
  return `${base}.xteink-rotated-${imageIndex}${extension}`;
}

function inferImageMediaType(filePath) {
  if (/\.png$/i.test(filePath)) {
    return "image/png";
  }

  if (/\.jpe?g$/i.test(filePath)) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}

function createManifestItem({ id, href, mediaType }) {
  return `<item id="${escapeHtml(id)}" href="${escapeHtml(href)}" media-type="${escapeHtml(mediaType)}" />`;
}

function updateOpf(opfXml, generatedManifestItems, nextSpineIds) {
  const manifestInsertion = generatedManifestItems.map((item) => `\t\t${item}`).join("\n");
  const manifestUpdated = opfXml.replace(/<\/manifest>/i, `${manifestInsertion}\n\t</manifest>`);
  const spineItemRefs = nextSpineIds.map((id) => `\t\t<itemref idref="${id}" />`).join("\n");

  return manifestUpdated.replace(
    /<spine\b([^>]*)>[\s\S]*?<\/spine>/i,
    (_full, attrs) => `<spine${attrs}>\n${spineItemRefs}\n\t</spine>`
  );
}

function buildGeneratedCss() {
  return `
body {
  margin: 0;
  padding: 0;
}

.xteink-image-page {
  margin: 0;
  padding: 0;
  page-break-before: always;
  page-break-after: always;
  text-align: center;
}

.xteink-image-page__image {
  display: block;
  width: 100%;
  height: auto;
  margin: 0 auto;
  border: 0;
}
`.trimStart();
}

async function buildEpubBuffer(entries) {
  const zipFile = new yazl.ZipFile();
  const chunks = [];
  const outputPromise = new Promise((resolve, reject) => {
    zipFile.outputStream.on("data", (chunk) => chunks.push(chunk));
    zipFile.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zipFile.outputStream.on("error", reject);
  });

  const mimetype = entries.get("mimetype");

  if (!mimetype) {
    throw new Error("EPUB is missing the required mimetype entry");
  }

  zipFile.addBuffer(mimetype, "mimetype", { compress: false });

  for (const entryPath of [...entries.keys()].sort()) {
    if (entryPath === "mimetype") {
      continue;
    }

    const buffer = entries.get(entryPath);

    if (buffer) {
      zipFile.addBuffer(buffer, entryPath);
    }
  }

  zipFile.end();
  return outputPromise;
}

function normalizeZipPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function joinPosix(directory, fileName) {
  if (!directory || directory === ".") {
    return normalizeZipPath(fileName);
  }

  return normalizeZipPath(path.posix.join(directory, fileName));
}

function sanitizeIdStem(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
