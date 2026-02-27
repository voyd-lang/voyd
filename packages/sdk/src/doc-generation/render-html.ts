import type {
  DocumentationItem,
  DocumentationModel,
  ModuleDocumentationSection,
} from "./types.js";

type TocNode = {
  key: string;
  label: string;
  depth: number;
  module?: ModuleDocumentationSection;
  children: TocNode[];
};

type KindSection = {
  title: string;
  items: readonly DocumentationItem[];
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderInlineMarkdown = (value: string): string => {
  const escaped = escapeHtml(value);
  return escaped
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, text, href) => `<a href="${escapeHtml(href)}">${text}</a>`,
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
};

const renderMarkdownToHtml = (markdown: string): string => {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const html: string[] = [];
  let inCodeFence = false;
  let codeLines: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const content = renderInlineMarkdown(paragraph.join("\n")).replace(
      /\n/g,
      "<br />\n",
    );
    html.push(`<p>${content}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    html.push(
      `<ul>${listItems
        .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
        .join("")}</ul>`,
    );
    listItems = [];
  };

  const flushCodeFence = () => {
    if (!inCodeFence) {
      return;
    }
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    inCodeFence = false;
  };

  lines.forEach((line) => {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeFence) {
        flushCodeFence();
      } else {
        inCodeFence = true;
        codeLines = [];
      }
      return;
    }

    if (inCodeFence) {
      codeLines.push(line);
      return;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1]!.length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2]!)}</h${level}>`);
      return;
    }

    const listMatch = /^[-*]\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1]!);
      return;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      return;
    }

    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  flushCodeFence();
  return html.join("\n");
};

const collectKindSections = (
  moduleDoc: ModuleDocumentationSection,
): readonly KindSection[] =>
  [
    { title: "Functions", items: moduleDoc.functions },
    { title: "Type Aliases", items: moduleDoc.typeAliases },
    { title: "Objects", items: moduleDoc.objects },
    { title: "Traits", items: moduleDoc.traits },
    { title: "Implementations", items: moduleDoc.impls },
  ].filter((section) => section.items.length > 0);

const collectAllModuleItems = (
  moduleDoc: ModuleDocumentationSection,
): readonly DocumentationItem[] =>
  collectKindSections(moduleDoc).flatMap((section) => section.items);

const buildTocTree = (modules: readonly ModuleDocumentationSection[]): TocNode[] => {
  const root: TocNode = {
    key: "__root__",
    label: "root",
    depth: 0,
    children: [],
  };

  modules.forEach((moduleDoc) => {
    const segments = moduleDoc.id.split("::");
    let current = root;

    segments.forEach((segment, index) => {
      const key = segments.slice(0, index + 1).join("::");
      const existing = current.children.find((child) => child.key === key);
      const node = existing ?? {
        key,
        label: segment,
        depth: index + 1,
        children: [],
      };
      if (!existing) {
        current.children.push(node);
      }
      if (index === segments.length - 1) {
        node.module = moduleDoc;
      }
      current = node;
    });
  });

  const sortNodes = (nodes: TocNode[]): TocNode[] =>
    [...nodes]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((node) => ({ ...node, children: sortNodes(node.children) }));

  return sortNodes(root.children);
};

const renderItemCard = (item: DocumentationItem): string => {
  const docsHtml =
    item.documentation !== undefined
      ? `<div class="doc-body">${renderMarkdownToHtml(item.documentation)}</div>`
      : `<p class="doc-missing">No documentation.</p>`;

  const parameterDocsHtml =
    item.parameterDocs.length > 0
      ? `<section class="item-meta">
  <h5>Parameters</h5>
  <ul>
    ${item.parameterDocs
      .map(
        (parameter) =>
          `<li><code>${escapeHtml(parameter.name)}</code><div class="member-doc">${renderMarkdownToHtml(
            parameter.documentation,
          )}</div></li>`,
      )
      .join("\n")}
  </ul>
</section>`
      : "";

  const membersHtml =
    item.members.length > 0
      ? `<section class="item-meta">
  <h5>Members</h5>
  ${item.members
    .map((member) => {
      const docs = member.documentation
        ? `<div class="member-doc">${renderMarkdownToHtml(member.documentation)}</div>`
        : `<p class="doc-missing">No documentation.</p>`;
      return `<section id="${member.anchor}" class="member">
  <h6><code>${escapeHtml(member.signature)}</code></h6>
  ${docs}
</section>`;
    })
    .join("\n")}
</section>`
      : "";

  return `<article id="${item.anchor}" class="doc-item">
  <h4><code>${escapeHtml(item.signature)}</code></h4>
  ${docsHtml}
  ${parameterDocsHtml}
  ${membersHtml}
</article>`;
};

const renderKindSection = (section: KindSection): string => `<section class="kind-section">
  <h3>${escapeHtml(section.title)}</h3>
  ${section.items.map(renderItemCard).join("\n")}
</section>`;

const renderSidebarNode = (node: TocNode): string => {
  const link = node.module
    ? `<a href="#${node.module.anchor}">${escapeHtml(node.label)}</a>`
    : `<span>${escapeHtml(node.label)}</span>`;
  const childNodes = node.children.map(renderSidebarNode).join("\n");
  const itemLinks = node.module
    ? collectAllModuleItems(node.module)
        .map(
          (item) =>
            `<li><a href="#${item.anchor}"><code>${escapeHtml(item.kind)}</code> ${escapeHtml(item.name)}</a></li>`,
        )
        .join("\n")
    : "";
  const shouldCollapse = node.depth > 1;
  const open = shouldCollapse ? "" : " open";
  const body = childNodes || itemLinks
    ? `<ul>${itemLinks}${childNodes}</ul>`
    : "";

  return `<li>
  <details${open}>
    <summary>${link}</summary>
    ${body}
  </details>
</li>`;
};

const renderTopToc = (modules: readonly ModuleDocumentationSection[]): string =>
  `<section class="toc-top">
  <h2>Table of Contents</h2>
  <ul>
    ${modules
      .map((moduleDoc) => {
        const counts = collectKindSections(moduleDoc)
          .map((section) => `${section.title}: ${section.items.length}`)
          .join(" | ");
        return `<li><a href="#${moduleDoc.anchor}"><code>mod</code> ${escapeHtml(
          moduleDoc.id,
        )}</a><span class="toc-counts">${escapeHtml(counts)}</span></li>`;
      })
      .join("\n")}
  </ul>
</section>`;

const renderModuleSection = (moduleDoc: ModuleDocumentationSection): string => {
  const moduleDocs =
    moduleDoc.documentation !== undefined
      ? `<div class="doc-body">${renderMarkdownToHtml(moduleDoc.documentation)}</div>`
      : `<p class="doc-missing">No module documentation.</p>`;
  const kindSections = collectKindSections(moduleDoc);

  return `<section id="${moduleDoc.anchor}" class="module-section">
  <header>
    <h2><code>mod</code> ${escapeHtml(moduleDoc.id)}</h2>
  </header>
  ${moduleDocs}
  ${kindSections.map(renderKindSection).join("\n")}
</section>`;
};

export const renderDocumentationHtml = ({
  model,
}: {
  model: DocumentationModel;
}): string => {
  const moduleTree = buildTocTree(model.modules);
  const sidebar = moduleTree.map(renderSidebarNode).join("\n");
  const topToc = renderTopToc(model.modules);
  const modules = model.modules.map(renderModuleSection).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(model.entryModule)} Documentation</title>
  <style>
    :root {
      --bg: #f7f6f2;
      --surface: #ffffff;
      --surface-soft: #f8faf8;
      --ink: #1f2528;
      --muted: #586068;
      --line: #d5dcd7;
      --accent: #0b7285;
      --accent-soft: #dbf0f5;
      --code-bg: #edf1ed;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 10% -10%, #ddece6 0%, transparent 30%),
        linear-gradient(180deg, #f3f6ef 0%, var(--bg) 40%);
      color: var(--ink);
      line-height: 1.55;
      padding: 1.1rem;
    }
    main {
      max-width: 1400px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: 0 20px 35px rgba(15, 23, 42, 0.08);
      overflow: hidden;
    }
    .hero {
      padding: 1.5rem;
      border-bottom: 1px solid var(--line);
      background: radial-gradient(circle at top right, var(--accent-soft), #ffffff 58%);
    }
    h1, h2, h3, h4, h5, h6 { margin: 0.65rem 0; line-height: 1.2; }
    h1 { font-size: 1.9rem; }
    h2 { font-size: 1.35rem; }
    h3 { font-size: 1.15rem; color: var(--muted); }
    .hero-meta { color: var(--muted); margin-top: 0.4rem; }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
    .sidebar {
      display: none;
      border-right: 1px solid var(--line);
      background: var(--surface-soft);
      padding: 1rem;
    }
    .sidebar h3 { margin-top: 0; color: var(--ink); }
    .sidebar-scroll {
      max-height: calc(100vh - 5rem);
      overflow: auto;
      position: sticky;
      top: 1rem;
      padding-right: 0.5rem;
    }
    .sidebar ul {
      margin: 0;
      padding-left: 1rem;
      list-style: none;
    }
    .sidebar li { margin: 0.25rem 0; }
    .sidebar summary { cursor: pointer; font-weight: 600; }
    .sidebar summary a { font-weight: 600; }
    .content {
      padding: 1rem 1.4rem 1.5rem;
    }
    .toc-top {
      background: var(--surface-soft);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 0.9rem 1rem;
      margin-bottom: 1rem;
    }
    .toc-top ul {
      list-style: none;
      margin: 0.4rem 0 0;
      padding: 0;
      display: grid;
      gap: 0.35rem;
    }
    .toc-top li { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: baseline; }
    .toc-counts { color: var(--muted); font-size: 0.85rem; }
    .module-section {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 1rem;
      margin-bottom: 1rem;
      background: linear-gradient(180deg, #ffffff 0%, #fdfefd 100%);
    }
    .module-section > header {
      border-bottom: 1px dashed var(--line);
      margin-bottom: 0.8rem;
      padding-bottom: 0.4rem;
    }
    .kind-section + .kind-section {
      border-top: 1px solid var(--line);
      margin-top: 1rem;
      padding-top: 0.8rem;
    }
    .doc-item {
      border: 1px solid var(--line);
      border-radius: 9px;
      background: #fff;
      padding: 0.85rem 0.9rem;
      margin: 0.7rem 0;
    }
    .item-meta {
      border-top: 1px dashed var(--line);
      margin-top: 0.75rem;
      padding-top: 0.65rem;
    }
    .item-meta ul {
      margin: 0;
      padding-left: 1rem;
    }
    .item-meta li { margin: 0.45rem 0; }
    .member {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fcfefd;
      padding: 0.5rem 0.65rem;
      margin: 0.5rem 0;
    }
    .doc-body p:first-child { margin-top: 0.2rem; }
    .doc-missing { color: var(--muted); }
    .member-doc p { margin: 0.35rem 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
      background: var(--code-bg);
      border-radius: 6px;
      padding: 0.14rem 0.35rem;
      font-size: 0.91em;
    }
    pre code {
      display: block;
      padding: 0.8rem;
      overflow-x: auto;
    }
    @media (min-width: 1060px) {
      .layout {
        grid-template-columns: 310px minmax(0, 1fr);
      }
      .sidebar { display: block; }
      .content { padding: 1.2rem 1.6rem 1.8rem; }
    }
    @media (max-width: 820px) {
      body { padding: 0.65rem; }
      .hero { padding: 1.15rem 1rem; }
      .content { padding: 0.85rem 0.9rem 1.2rem; }
      .module-section { padding: 0.85rem; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <h1>${escapeHtml(model.entryModule)}</h1>
      <p class="hero-meta">Voyd API documentation generated from source declarations.</p>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-scroll">
          <h3>Docs Index</h3>
          <ul>
            ${sidebar}
          </ul>
        </div>
      </aside>
      <article class="content">
        ${topToc}
        ${modules}
      </article>
    </div>
  </main>
</body>
</html>`;
};
