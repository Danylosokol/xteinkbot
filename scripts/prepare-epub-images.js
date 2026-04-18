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
  outputEpubPath: path.join(projectRoot, "ddd.landscape-images.epub"),
  workingDirectory: path.join(projectRoot, ".tmp", "epub-landscape-work"),
  injectedCssName: "xteink-landscape-images.css"
};

async function main() {
  await ensureFileExists(CONFIG.inputEpubPath);
  await fs.rm(CONFIG.workingDirectory, { recursive: true, force: true });
  await fs.mkdir(CONFIG.workingDirectory, { recursive: true });

  await unzipEpub(CONFIG.inputEpubPath, CONFIG.workingDirectory);

  const opfPath = await resolveOpfPath(CONFIG.workingDirectory);
  const opfDirectory = path.dirname(opfPath);
  const contentFiles = await findContentDocuments(opfDirectory);

  if (contentFiles.length === 0) {
    throw new Error("No XHTML/HTML content files were found inside the EPUB package.");
  }

  const cssPath = path.join(opfDirectory, CONFIG.injectedCssName);
  await fs.writeFile(cssPath, buildInjectedCss(), "utf8");

  let totalImagesRewritten = 0;

  for (const contentFile of contentFiles) {
    const original = await fs.readFile(contentFile, "utf8");
    const cssHref = toPosixPath(path.relative(path.dirname(contentFile), cssPath));
    const updated = rewriteDocument(original, cssHref);

    if (updated.changed) {
      await fs.writeFile(contentFile, updated.content, "utf8");
      totalImagesRewritten += updated.rewrittenImages;
    }
  }

  await rezipEpub(CONFIG.workingDirectory, CONFIG.outputEpubPath);

  console.log(`Created: ${CONFIG.outputEpubPath}`);
  console.log(`Processed content files: ${contentFiles.length}`);
  console.log(`Rewritten images: ${totalImagesRewritten}`);
}

async function ensureFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(
      `Input EPUB not found at ${filePath}. Update CONFIG.inputEpubPath to point at a real file before running the script.`
    );
  }
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

  return path.join(rootDirectory, match[1]);
}

async function findContentDocuments(rootDirectory) {
  const files = [];
  const stack = [rootDirectory];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (/\.(xhtml|html|htm)$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}

function rewriteDocument(content, cssFileName) {
  let updated = ensureStylesheetLink(content, cssFileName);
  let rewrittenImages = 0;
  let imageIndex = 0;

  const imageTagPattern = /<img\b([^>]*?)\/?>/gi;

  updated = updated.replace(imageTagPattern, (fullMatch, attrs) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);

    if (!srcMatch) {
      return fullMatch;
    }

    const altMatch = attrs.match(/\balt\s*=\s*(['"])(.*?)\1/i);
    const altText = altMatch ? decodeAttribute(altMatch[2]) : "Illustration";
    const src = srcMatch[2];
    const id = `xteink-landscape-image-${imageIndex++}`;
    const cleanAttrs = stripClassAttribute(attrs);
    const mergedClassName = mergeClasses(attrs, "xteink-landscape-image");

    rewrittenImages += 1;

    return [
      `<div class="xteink-landscape-block" id="${id}">`,
      `  <div class="xteink-landscape-frame">`,
      `    <img${cleanAttrs} class="${mergedClassName}" />`,
      "  </div>",
      `  <div class="xteink-landscape-caption">${escapeHtml(altText || src)}</div>`,
      "</div>"
    ].join("\n");
  });

  return {
    changed: rewrittenImages > 0 || updated !== content,
    content: updated,
    rewrittenImages
  };
}

function ensureStylesheetLink(content, cssFileName) {
  if (content.includes(cssFileName)) {
    return content;
  }

  const linkTag = `\n<link rel="stylesheet" type="text/css" href="${cssFileName}" />`;

  if (/<\/head>/i.test(content)) {
    return content.replace(/<\/head>/i, `${linkTag}\n</head>`);
  }

  if (/<html\b[^>]*>/i.test(content)) {
    return content.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${linkTag}\n</head>`);
  }

  return `${linkTag}\n${content}`;
}

function mergeClasses(attrs, additionalClass) {
  const classMatch = attrs.match(/\bclass\s*=\s*(['"])(.*?)\1/i);

  if (!classMatch) {
    return additionalClass;
  }

  const existing = classMatch[2].trim();
  return `${existing} ${additionalClass}`.trim();
}

function stripClassAttribute(attrs) {
  return attrs.replace(/\s*\bclass\s*=\s*(['"])(.*?)\1/i, "");
}

function decodeAttribute(value) {
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

function buildInjectedCss() {
  return `
body {
  overflow: visible;
}

.xteink-landscape-block {
  break-before: page;
  break-after: page;
  page-break-before: always;
  page-break-after: always;
  -webkit-column-break-before: always;
  -webkit-column-break-after: always;
  margin: 0;
  padding: 0;
  text-align: center;
}

.xteink-landscape-frame {
  height: 100vh;
  min-height: 100vh;
  display: block;
  position: relative;
  overflow: visible;
}

.xteink-landscape-image {
  display: block;
  margin: 0 auto;
  max-width: calc(100vh - 2rem);
  max-height: calc(100vw - 2rem);
  width: auto;
  height: auto;
  object-fit: contain;
  transform: rotate(90deg);
  transform-origin: center center;
}

.xteink-landscape-caption {
  display: none;
}
`.trimStart();
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function rezipEpub(sourceDirectory, outputPath) {
  await fs.rm(outputPath, { force: true });

  const mimetypePath = path.join(sourceDirectory, "mimetype");
  await ensureFileExists(mimetypePath);

  await execFileAsync(
    "zip",
    ["-X0", outputPath, "mimetype"],
    { cwd: sourceDirectory }
  );

  const entries = await fs.readdir(sourceDirectory);
  const additionalEntries = entries.filter((entry) => entry !== "mimetype");

  if (additionalEntries.length > 0) {
    await execFileAsync(
      "zip",
      ["-Xr9D", outputPath, ...additionalEntries],
      { cwd: sourceDirectory }
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
