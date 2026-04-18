import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const CONFIG = {
  inputEpubPath: path.join(projectRoot, "ddd.epub"),
  outputEpubPath: path.join(projectRoot, "ddd.rotated-image-pages.epub"),
  workingDirectory: path.join(projectRoot, ".tmp", "epub-rotated-pages-work"),
  generatedCssName: "xteink-rotated-pages.css",
  imageRotationDegrees: "90"
};

async function main() {
  await ensureFileExists(CONFIG.inputEpubPath);
  await fs.rm(CONFIG.workingDirectory, { recursive: true, force: true });
  await fs.mkdir(CONFIG.workingDirectory, { recursive: true });

  await unzipEpub(CONFIG.inputEpubPath, CONFIG.workingDirectory);

  const opfPath = await resolveOpfPath(CONFIG.workingDirectory);
  const opfDirectory = path.dirname(opfPath);
  const opfXml = await fs.readFile(opfPath, "utf8");
  const manifestItems = parseManifestItems(opfXml);
  const spineIds = parseSpineIds(opfXml);

  const generatedCssPath = path.join(opfDirectory, CONFIG.generatedCssName);
  await fs.writeFile(generatedCssPath, buildGeneratedCss(), "utf8");

  const generatedManifestItems = [
    createManifestItemXml({
      id: "xteink_rotated_pages_css",
      href: CONFIG.generatedCssName,
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

    const contentPath = path.join(opfDirectory, toSystemPath(manifestItem.href));
    const originalContent = await fs.readFile(contentPath, "utf8");
    const rewriteResult = await rewriteContentDocument({
      content: originalContent,
      contentHref: manifestItem.href,
      contentPath,
      opfDirectory
    });

    if (!rewriteResult.changed) {
      nextSpineIds.push(spineId);
      continue;
    }

    generatedManifestItems.push(...rewriteResult.manifestEntries);
    nextSpineIds.push(...rewriteResult.spineIds);
  }

  const updatedOpfXml = updateOpf(opfXml, generatedManifestItems, nextSpineIds);
  await fs.writeFile(opfPath, updatedOpfXml, "utf8");
  await rezipEpub(CONFIG.workingDirectory, CONFIG.outputEpubPath);

  console.log(`Created: ${CONFIG.outputEpubPath}`);
  console.log(`Generated manifest items: ${generatedManifestItems.length}`);
  console.log(`Spine items after rewrite: ${nextSpineIds.length}`);
}

async function rewriteContentDocument({ content, contentHref, contentPath, opfDirectory }) {
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
      const relativeCssHref = toPosixPath(
        path.posix.relative(path.posix.dirname(href), CONFIG.generatedCssName)
      );
      const segmentHtml = buildTextDocument({
        template: split.template,
        bodyHtml: segment.bodyHtml,
        generatedCssHref: relativeCssHref
      });

      await writeFileEnsuringDirectory(path.join(opfDirectory, toSystemPath(href)), segmentHtml);

      manifestEntries.push(
        createManifestItemXml({
          id,
          href,
          mediaType: "application/xhtml+xml"
        })
      );
      spineIds.push(id);
      textIndex += 1;
      continue;
    }

    const sourceImageHref = path.posix.normalize(
      path.posix.join(path.posix.dirname(contentHref), segment.src)
    );
    const sourceImagePath = path.join(opfDirectory, toSystemPath(sourceImageHref));
    const rotatedImageHref = buildRotatedImageHref(sourceImageHref, imageIndex);
    const rotatedImagePath = path.join(opfDirectory, toSystemPath(rotatedImageHref));
    await rotateImage(sourceImagePath, rotatedImagePath);

    const imagePageHref = joinPosix(contentDirectory, `${baseName}.xteink-image-${imageIndex}.html`);
    const imagePageId = `${idStem}_xteink_image_${imageIndex}`;
    const imageManifestId = `${idStem}_xteink_image_asset_${imageIndex}`;
    const imageMediaType = inferImageMediaType(rotatedImageHref);
    const relativeImageHref = toPosixPath(
      path.posix.relative(path.posix.dirname(imagePageHref), rotatedImageHref)
    );
    const relativeCssHref = toPosixPath(
      path.posix.relative(path.posix.dirname(imagePageHref), CONFIG.generatedCssName)
    );

    await writeFileEnsuringDirectory(
      path.join(opfDirectory, toSystemPath(imagePageHref)),
      buildImageDocument({
        template: split.template,
        generatedCssHref: relativeCssHref,
        imageHref: relativeImageHref,
        altText: segment.altText
      })
    );

    manifestEntries.push(
      createManifestItemXml({
        id: imageManifestId,
        href: rotatedImageHref,
        mediaType: imageMediaType
      })
    );
    manifestEntries.push(
      createManifestItemXml({
        id: imagePageId,
        href: imagePageHref,
        mediaType: "application/xhtml+xml"
      })
    );
    spineIds.push(imagePageId);
    imageIndex += 1;
  }

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
      segments.push({
        type: "text",
        bodyHtml: bodyInnerHtml.slice(cursor, block.index)
      });
    }

    segments.push({
      type: "image",
      src: block.src,
      altText: block.altText
    });
    cursor = block.index + block.length;
  }

  if (cursor < bodyInnerHtml.length) {
    segments.push({
      type: "text",
      bodyHtml: bodyInnerHtml.slice(cursor)
    });
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
  const blockPattern = /<(p|div)\b[^>]*>\s*<img\b([^>]*?)\/?>\s*<\/\1>/gi;
  const blocks = [];
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
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, "i");
  const match = attrs.match(pattern);
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

function buildRotatedImageHref(sourceImageHref, imageIndex) {
  const extension = path.posix.extname(sourceImageHref);
  const base = sourceImageHref.slice(0, -extension.length);
  return `${base}.xteink-rotated-${imageIndex}${extension}`;
}

function sanitizeIdStem(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function joinPosix(directory, fileName) {
  if (!directory || directory === ".") {
    return fileName;
  }

  return path.posix.join(directory, fileName);
}

async function rotateImage(sourcePath, destinationPath) {
  await writeDirectory(path.dirname(destinationPath));
  await execFileAsync("sips", [
    "-r",
    CONFIG.imageRotationDegrees,
    sourcePath,
    "--out",
    destinationPath
  ]);
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

function parseManifestItems(opfXml) {
  const itemPattern = /<item\b([^>]*?)\/>/gi;
  const items = new Map();
  let match;

  while ((match = itemPattern.exec(opfXml)) !== null) {
    const attrs = match[1];
    const id = readAttribute(attrs, "id");
    const href = readAttribute(attrs, "href");
    const mediaType = readAttribute(attrs, "media-type");

    if (id) {
      items.set(id, { id, href, mediaType });
    }
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

function updateOpf(opfXml, generatedManifestItems, nextSpineIds) {
  const manifestInsertion = generatedManifestItems.map((item) => `\t\t${item}`).join("\n");
  const manifestUpdated = opfXml.replace(
    /<\/manifest>/i,
    `${manifestInsertion}\n\t</manifest>`
  );

  const spineItemRefs = nextSpineIds
    .map((id) => `\t\t<itemref idref="${id}" />`)
    .join("\n");

  return manifestUpdated.replace(
    /<spine\b([^>]*)>[\s\S]*?<\/spine>/i,
    (_match, attrs) => `<spine${attrs}>\n${spineItemRefs}\n\t</spine>`
  );
}

function createManifestItemXml({ id, href, mediaType }) {
  return `<item id="${escapeHtml(id)}" href="${escapeHtml(href)}" media-type="${escapeHtml(mediaType)}" />`;
}

async function unzipEpub(inputPath, outputDirectory) {
  await execFileAsync("unzip", ["-oq", inputPath, "-d", outputDirectory]);
}

async function resolveOpfPath(rootDirectory) {
  const containerPath = path.join(rootDirectory, "META-INF", "container.xml");
  const containerXml = await fs.readFile(containerPath, "utf8");
  const match = containerXml.match(/full-path="([^"]+)"/i);

  if (!match) {
    throw new Error("Could not find the OPF package path in META-INF/container.xml.");
  }

  return path.join(rootDirectory, toSystemPath(match[1]));
}

async function writeFileEnsuringDirectory(filePath, contents) {
  await writeDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, contents, "utf8");
}

async function writeDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
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

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function toSystemPath(filePath) {
  return filePath.split("/").join(path.sep);
}

async function ensureFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing file: ${filePath}`);
  }
}

async function rezipEpub(sourceDirectory, outputPath) {
  await fs.rm(outputPath, { force: true });
  await ensureFileExists(path.join(sourceDirectory, "mimetype"));

  await execFileAsync("zip", ["-X0", outputPath, "mimetype"], {
    cwd: sourceDirectory
  });

  const entries = await fs.readdir(sourceDirectory);
  const additionalEntries = entries.filter((entry) => entry !== "mimetype");

  if (additionalEntries.length > 0) {
    await execFileAsync("zip", ["-Xr9D", outputPath, ...additionalEntries], {
      cwd: sourceDirectory
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
