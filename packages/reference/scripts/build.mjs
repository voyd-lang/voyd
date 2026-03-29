import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const referenceRoot = path.resolve(__dirname, "..");
const docsRoot = path.join(referenceRoot, "docs");
const distDir = path.join(referenceRoot, "dist");

const args = new Set(process.argv.slice(2));
const shouldWatch = args.has("--watch");
const checkOnly = args.has("--check");

const ignoredDirs = new Set(["dist", "node_modules", ".turbo"]);

function walkMarkdownFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      out.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(fullPath);
  }
  return out;
}

function extractMarkdownLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)\s]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const href = match[1];
    if (href) links.push(href);
  }
  return links;
}

function hasExternalScheme(href) {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(href) || href.startsWith("//");
}

function stripSearchAndHash(href) {
  const hashIndex = href.indexOf("#");
  const queryIndex = href.indexOf("?");
  const end =
    hashIndex === -1
      ? queryIndex === -1
        ? href.length
        : queryIndex
      : queryIndex === -1
        ? hashIndex
        : Math.min(hashIndex, queryIndex);
  return href.slice(0, end);
}

function validateMarkdownLinks(mdFiles) {
  const knownFiles = new Set(mdFiles.map((filePath) => path.normalize(filePath)));

  mdFiles.forEach((filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    const { body } = parseFrontmatter(raw);

    extractMarkdownLinks(body).forEach((href) => {
      if (href.startsWith("#") || hasExternalScheme(href)) {
        return;
      }

      const targetPath = stripSearchAndHash(href);
      if (!targetPath.endsWith(".md")) {
        return;
      }

      const resolved = path.normalize(path.resolve(path.dirname(filePath), targetPath));
      const relativeToDocs = path.relative(docsRoot, resolved);
      const escapesDocsRoot =
        relativeToDocs.startsWith("..") || path.isAbsolute(relativeToDocs);

      if (escapesDocsRoot || !knownFiles.has(resolved)) {
        const relSource = path.relative(referenceRoot, filePath).replaceAll(path.sep, "/");
        throw new Error(`Broken doc link in ${relSource}: ${href}`);
      }
    });
  });
}

function slugFromFile(filePath) {
  const rel = path.relative(docsRoot, filePath).replaceAll(path.sep, "/");
  if (!rel.endsWith(".md")) throw new Error(`Expected markdown file: ${rel}`);
  const withoutExt = rel.slice(0, -3);
  if (withoutExt === "README") return "";
  if (withoutExt.endsWith("/README")) return withoutExt.slice(0, -"/README".length);
  return withoutExt;
}

function titleFromMarkdown(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)\s*$/m);
  return (m?.[1] ?? fallback).trim();
}

function titleFromSlug(slug, fallback) {
  if (!slug) return fallback;
  const leaf = slug.split("/").at(-1) ?? fallback;
  return leaf
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatter(markdown) {
  const frontmatterMatch = markdown.match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  );
  if (!frontmatterMatch) return { body: markdown, frontmatter: {} };

  const rawFrontmatter = frontmatterMatch[1] ?? "";
  const frontmatter = rawFrontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce((acc, line) => {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (!kv) return acc;
      const key = kv[1];
      const value = kv[2].trim();
      const unquoted = value.replace(/^["'](.*)["']$/, "$1");
      acc[key] = unquoted;
      return acc;
    }, {});

  return {
    body: markdown.slice(frontmatterMatch[0].length),
    frontmatter,
  };
}

function parseOrder(value) {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildReference() {
  const mdFiles = walkMarkdownFiles(docsRoot);
  validateMarkdownLinks(mdFiles);

  const docs = mdFiles
    .map((filePath) => {
      const slug = slugFromFile(filePath);
      const rawBody = fs.readFileSync(filePath, "utf8");
      const { body, frontmatter } = parseFrontmatter(rawBody);
      const order = parseOrder(frontmatter.order);
      const fallbackTitle = titleFromSlug(slug, "Documentation");
      const inferredTitle =
        slug === ""
          ? titleFromMarkdown(body, fallbackTitle)
          : fallbackTitle;
      const title = (frontmatter.title ?? inferredTitle).trim();
      return {
        slug,
        title,
        body,
        ...(order === null ? {} : { order }),
      };
    })
    .sort((a, b) => {
      const aOrder = a.order ?? Number.POSITIVE_INFINITY;
      const bOrder = b.order ?? Number.POSITIVE_INFINITY;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (a.slug === "") return -1;
      if (b.slug === "") return 1;
      return a.slug.localeCompare(b.slug);
    });

  const docsBySlug = Object.fromEntries(docs.map((d) => [d.slug, d]));
  const nav = docs.map(({ slug, title, order }) => ({
    slug,
    title,
    ...(typeof order === "number" ? { order } : {}),
  }));

  const js = [
    "// This file is generated by packages/reference/scripts/build.mjs",
    "",
    `export const referenceDocs = ${JSON.stringify(docsBySlug, null, 2)};`,
    "",
    `export const referenceNav = ${JSON.stringify(nav, null, 2)};`,
    "",
    "export function getReferenceDoc(slug) {",
    "  return referenceDocs[slug] ?? null;",
    "}",
    "",
    "export default referenceNav;",
    "",
  ].join("\n");

  const dts = [
    "// This file is generated by packages/reference/scripts/build.mjs",
    "",
    "export type ReferenceDoc = {",
    "  slug: string;",
    "  title: string;",
    "  body: string;",
    "  order?: number;",
    "};",
    "",
    "export type ReferenceNavItem = Pick<ReferenceDoc, \"slug\" | \"title\" | \"order\">;",
    "",
    "export declare const referenceDocs: Record<string, ReferenceDoc>;",
    "export declare const referenceNav: Array<ReferenceNavItem>;",
    "export declare function getReferenceDoc(slug: string): ReferenceDoc | null;",
    "declare const _default: typeof referenceNav;",
    "export default _default;",
    "",
  ].join("\n");

  if (checkOnly) {
    const expectedJsPath = path.join(distDir, "index.js");
    const expectedDistDtsPath = path.join(distDir, "index.d.ts");
    const expectedRootDtsPath = path.join(referenceRoot, "index.d.ts");

    const existingJs = fs.existsSync(expectedJsPath)
      ? fs.readFileSync(expectedJsPath, "utf8")
      : "";
    const existingDistDts = fs.existsSync(expectedDistDtsPath)
      ? fs.readFileSync(expectedDistDtsPath, "utf8")
      : "";
    const existingRootDts = fs.existsSync(expectedRootDtsPath)
      ? fs.readFileSync(expectedRootDtsPath, "utf8")
      : "";

    if (existingJs !== js || existingDistDts !== dts || existingRootDts !== dts) {
      throw new Error(
        "packages/reference dist is out of date. Run `npm -w @voyd-lang/reference run build`."
      );
    }
    return;
  }

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.js"), js);
  fs.writeFileSync(path.join(distDir, "index.d.ts"), dts);
  fs.writeFileSync(path.join(referenceRoot, "index.d.ts"), dts);
}

function main() {
  buildReference();

  if (!shouldWatch) return;

  // Coalesce bursts of file events into a single rebuild.
  let timer = null;
  let previousSnapshot = createWatchSnapshot();
  const rebuild = () => {
    try {
      buildReference();
      previousSnapshot = createWatchSnapshot();
      process.stdout.write("[reference] rebuilt\n");
    } catch (err) {
      process.stderr.write(String(err?.stack ?? err) + "\n");
    }
  };

  const interval = setInterval(() => {
    const nextSnapshot = createWatchSnapshot();
    if (snapshotsEqual(previousSnapshot, nextSnapshot)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 50);
  }, 250);

  process.stdout.write("[reference] watching...\n");
}

function createWatchSnapshot() {
  return walkMarkdownFiles(docsRoot)
    .map((filePath) => {
      const stats = fs.statSync(filePath);
      return `${filePath}:${stats.mtimeMs}`;
    })
    .sort();
}

function snapshotsEqual(previousSnapshot, nextSnapshot) {
  if (previousSnapshot.length !== nextSnapshot.length) return false;
  return previousSnapshot.every((entry, index) => entry === nextSnapshot[index]);
}

main();
