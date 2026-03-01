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

type SignatureToken = {
  text: string;
  className?: string;
};

const SIDEBAR_KIND_LABEL: Record<DocumentationItem["kind"], string> = {
  re_export: "pub",
  macro: "macro",
  module_let: "let",
  function: "fn",
  type_alias: "type",
  object: "obj",
  trait: "trait",
  effect: "eff",
  impl: "impl",
};

const SIGNATURE_KEYWORDS = new Set([
  "pub",
  "use",
  "as",
  "macro",
  "let",
  "fn",
  "obj",
  "trait",
  "impl",
  "eff",
  "type",
  "mod",
  "for",
  "resume",
  "tail",
]);

const BUILTIN_TYPES = new Set([
  "void",
  "bool",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "f32",
  "f64",
]);

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const nextNonWhitespaceToken = (
  tokens: readonly SignatureToken[],
  start: number,
): SignatureToken | undefined => {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.className !== "tok-space") {
      return token;
    }
  }
  return undefined;
};

const previousNonWhitespaceToken = (
  tokens: readonly SignatureToken[],
  start: number,
): SignatureToken | undefined => {
  for (let index = start; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.className !== "tok-space") {
      return token;
    }
  }
  return undefined;
};

const tokenizeSignature = (signature: string): SignatureToken[] => {
  const tokens: SignatureToken[] = [];
  let index = 0;

  while (index < signature.length) {
    const char = signature[index]!;

    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < signature.length && /\s/.test(signature[end] ?? "")) {
        end += 1;
      }
      tokens.push({
        text: signature.slice(index, end),
        className: "tok-space",
      });
      index = end;
      continue;
    }

    if (char === "-" && signature[index + 1] === ">") {
      tokens.push({ text: "->", className: "tok-punct" });
      index += 2;
      continue;
    }

    if ("(){}[]<>,:?~".includes(char)) {
      tokens.push({ text: char, className: "tok-punct" });
      index += 1;
      continue;
    }

    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < signature.length && /[0-9]/.test(signature[end] ?? "")) {
        end += 1;
      }
      tokens.push({ text: signature.slice(index, end), className: "tok-num" });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (
        end < signature.length &&
        /[A-Za-z0-9_]/.test(signature[end] ?? "")
      ) {
        end += 1;
      }
      const word = signature.slice(index, end);
      if (SIGNATURE_KEYWORDS.has(word)) {
        tokens.push({ text: word, className: "tok-kw" });
      } else if (BUILTIN_TYPES.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        tokens.push({ text: word, className: "tok-type" });
      } else {
        tokens.push({ text: word, className: "tok-id" });
      }
      index = end;
      continue;
    }

    tokens.push({ text: char });
    index += 1;
  }

  return tokens.map((token, tokenIndex) => {
    if (token.className !== "tok-id") {
      return token;
    }

    const previousToken = previousNonWhitespaceToken(tokens, tokenIndex - 1);
    const nextToken = nextNonWhitespaceToken(tokens, tokenIndex + 1);
    const previousText = previousToken?.text;
    const nextText = nextToken?.text;

    if (
      nextText === "(" ||
      (nextText === "<" &&
        (previousText === undefined || previousText === "fn"))
    ) {
      return { ...token, className: "tok-name" };
    }
    if (previousText === "macro") {
      return { ...token, className: "tok-name" };
    }

    if (
      previousText &&
      SIGNATURE_KEYWORDS.has(previousText) &&
      previousText !== "fn"
    ) {
      return { ...token, className: "tok-type" };
    }

    return token;
  });
};

const renderSignatureHtml = (signature: string): string =>
  tokenizeSignature(signature)
    .map((token) => {
      const text = escapeHtml(token.text);
      return token.className
        ? `<span class="${token.className}">${text}</span>`
        : text;
    })
    .join("");

const renderInlineMarkdown = (value: string): string => {
  const escaped = escapeHtml(value);
  return escaped
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, text, href) => `<a href="${href}">${text}</a>`,
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
  let codeFenceIndent = 0;
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
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeFence) {
        flushCodeFence();
      } else {
        inCodeFence = true;
        codeLines = [];
        codeFenceIndent = line.length - trimmed.length;
      }
      return;
    }

    if (inCodeFence) {
      const indentPrefix = " ".repeat(codeFenceIndent);
      const normalizedCodeLine = line.startsWith(indentPrefix)
        ? line.slice(codeFenceIndent)
        : line;
      codeLines.push(normalizedCodeLine);
      return;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1]!.length;
      html.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2]!)}</h${level}>`,
      );
      return;
    }

    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
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

    paragraph.push(trimmed);
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
    { title: "Re-Exports", items: moduleDoc.reexports },
    { title: "Macros", items: moduleDoc.macros },
    { title: "Module Lets", items: moduleDoc.moduleLets },
    { title: "Functions", items: moduleDoc.functions },
    { title: "Type Aliases", items: moduleDoc.typeAliases },
    { title: "Objects", items: moduleDoc.objects },
    { title: "Traits", items: moduleDoc.traits },
    { title: "Effects", items: moduleDoc.effects },
    { title: "Implementations", items: moduleDoc.impls },
  ].filter((section) => section.items.length > 0);

const collectAllModuleItems = (
  moduleDoc: ModuleDocumentationSection,
): readonly DocumentationItem[] =>
  collectKindSections(moduleDoc).flatMap((section) => section.items);

const buildTocTree = (
  modules: readonly ModuleDocumentationSection[],
): TocNode[] => {
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

  const sortedNodes = sortNodes(root.children);
  const shiftedNodes =
    sortedNodes.length === 1 && sortedNodes[0]?.module === undefined
      ? sortedNodes[0]!.children
      : sortedNodes;

  const rebaseDepths = (nodes: readonly TocNode[], depth: number): TocNode[] =>
    nodes.map((node) => ({
      ...node,
      depth,
      children: rebaseDepths(node.children, depth + 1),
    }));

  return rebaseDepths(shiftedNodes, 1);
};

const renderItemCard = ({ item }: { item: DocumentationItem }): string => {
  const docsHtml =
    item.documentation !== undefined
      ? `<div class="doc-body">${renderMarkdownToHtml(item.documentation)}</div>`
      : "";

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
        : "";
      return `<section id="${member.anchor}" class="member">
  <h6><code class="sig">${renderSignatureHtml(member.signature)}</code></h6>
  ${docs}
</section>`;
    })
    .join("\n")}
</section>`
      : "";

  return `<article id="${item.anchor}" class="doc-item">
  <h4><code class="sig">${renderSignatureHtml(item.signature)}</code></h4>
  ${docsHtml}
  ${parameterDocsHtml}
  ${membersHtml}
</article>`;
};

const renderKindSection = (
  section: KindSection,
): string => `<section class="kind-section">
  <h3>${escapeHtml(section.title)}</h3>
  ${section.items.map((item) => renderItemCard({ item })).join("\n")}
</section>`;

const sidebarItemName = (item: DocumentationItem): string => {
  if (item.kind === "impl") {
    return item.targetName ?? item.name;
  }
  if (item.kind === "re_export") {
    return item.signature.replace(/^pub\s+/, "");
  }
  return item.name;
};

const renderSidebarDeclarationNode = (
  item: DocumentationItem,
): string => `<li class="sidebar-decl">
  <a href="#${item.anchor}">
    <code>${SIDEBAR_KIND_LABEL[item.kind]}</code> ${escapeHtml(sidebarItemName(item))}
  </a>
</li>`;

const renderSidebarNode = (node: TocNode): string => {
  const link = node.module
    ? `<a href="#${node.module.anchor}">${escapeHtml(node.label)}</a>`
    : `<span>${escapeHtml(node.label)}</span>`;
  const declarationNodes = node.module
    ? collectAllModuleItems(node.module)
        .map(renderSidebarDeclarationNode)
        .join("\n")
    : "";
  const childModuleNodes = node.children.map(renderSidebarNode).join("\n");
  const hasChildren =
    declarationNodes.length > 0 || childModuleNodes.length > 0;

  if (!hasChildren) {
    return `<li>${link}</li>`;
  }

  const body = [declarationNodes, childModuleNodes]
    .filter((entries) => entries.length > 0)
    .join("\n");

  return `<li>
  <details>
    <summary>${link}</summary>
    <ul>${body}</ul>
  </details>
</li>`;
};

const renderTopToc = (modules: readonly ModuleDocumentationSection[]): string =>
  `<section class="toc-top">
  <h2>Table of Contents</h2>
  <ul>
    ${modules
      .map((moduleDoc) => {
        const counts =
          collectAllModuleItems(moduleDoc).length > 0
            ? collectKindSections(moduleDoc)
                .map((section) => `${section.title}: ${section.items.length}`)
                .join(" | ")
            : "No public API items";
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
      : "";
  const kindSections = collectKindSections(moduleDoc);
  const implsByTargetName = moduleDoc.impls.reduce<
    Map<string, DocumentationItem[]>
  >((acc, implItem) => {
    if (!implItem.targetName) {
      return acc;
    }
    const bucket = acc.get(implItem.targetName) ?? [];
    bucket.push(implItem);
    acc.set(implItem.targetName, bucket);
    return acc;
  }, new Map());
  const attachedImplAnchors = new Set<string>();

  const renderKindSectionWithAttachedImpls = (section: KindSection): string => {
    if (section.title === "Implementations") {
      const remainingImpls = section.items.filter(
        (item) => !attachedImplAnchors.has(item.anchor),
      );
      if (remainingImpls.length === 0) {
        return "";
      }
      return renderKindSection({
        title: section.title,
        items: remainingImpls,
      });
    }

    const canAttachImpls =
      section.title === "Objects" || section.title === "Type Aliases";
    const body = section.items
      .map((item) => {
        if (!canAttachImpls) {
          return renderItemCard({ item });
        }
        const linkedImpls = implsByTargetName.get(item.name) ?? [];
        linkedImpls.forEach((implItem) =>
          attachedImplAnchors.add(implItem.anchor),
        );
        if (linkedImpls.length === 0) {
          return renderItemCard({ item });
        }
        return `${renderItemCard({ item })}
${linkedImpls.map((implItem) => renderItemCard({ item: implItem })).join("\n")}`;
      })
      .join("\n");

    return `<section class="kind-section">
  <h3>${escapeHtml(section.title)}</h3>
  ${body}
</section>`;
  };
  const renderedSections = kindSections
    .map(renderKindSectionWithAttachedImpls)
    .filter((section) => section.length > 0)
    .join("\n");

  return `<section id="${moduleDoc.anchor}" class="module-section">
  <header>
    <h2><code>mod</code> ${escapeHtml(moduleDoc.id)}</h2>
  </header>
  ${moduleDocs}
  ${renderedSections}
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
      --bg: #f2f5f3;
      --surface: #ffffff;
      --surface-soft: #f6f8f7;
      --ink: #1a2124;
      --muted: #5f676e;
      --line: #dce3df;
      --line-soft: #e8eeea;
      --accent: #136f63;
      --accent-soft: #ebf4f0;
      --code-bg: #f1f4f2;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 10% -10%, #e5efe9 0%, transparent 36%),
        linear-gradient(180deg, #f4f7f3 0%, var(--bg) 52%);
      color: var(--ink);
      line-height: 1.55;
      padding: 1.1rem;
    }
    main {
      max-width: 1400px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--line-soft);
      border-radius: 16px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
    }
    .hero {
      padding: 1.5rem;
      border-bottom: 1px solid var(--line-soft);
      background: radial-gradient(circle at top right, var(--accent-soft), #ffffff 62%);
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
      border-right: 1px solid var(--line-soft);
      background: transparent;
      padding: 0.85rem 0.7rem 0.7rem;
      position: sticky;
      top: 0.9rem;
      max-height: calc(100vh - 1.8rem);
      overflow: auto;
    }
    .sidebar h3 {
      margin: 0 0 0.5rem;
      color: var(--ink);
      padding: 0 0.35rem;
    }
    .sidebar ul {
      margin: 0;
      padding-left: 0.9rem;
      list-style: none;
    }
    .sidebar li { margin: 0.25rem 0; }
    .sidebar summary { cursor: pointer; font-weight: 560; color: #4b545c; }
    .sidebar summary a { font-weight: 600; }
    .sidebar-decl a { font-weight: 500; color: #4c5963; }
    .sidebar-decl code {
      font-size: 0.78em;
      padding: 0.08rem 0.25rem;
      margin-right: 0.14rem;
    }
    .content {
      padding: 1rem 1.4rem 1.5rem;
    }
    .toc-top {
      background: var(--surface-soft);
      border: 1px solid var(--line-soft);
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
      padding: 1.05rem 0 0.95rem;
      margin: 0;
      background: transparent;
    }
    .module-section + .module-section { border-top: 1px solid var(--line-soft); }
    .module-section > header {
      border-bottom: 1px solid var(--line-soft);
      margin: 0 0.25rem 0.8rem;
      padding-bottom: 0.46rem;
    }
    .kind-section + .kind-section {
      border-top: 1px solid var(--line-soft);
      margin-top: 1rem;
      padding-top: 0.8rem;
    }
    .doc-item {
      border-bottom: 1px solid var(--line-soft);
      padding: 0.5rem 0.35rem 0.72rem;
      margin: 0.45rem 0;
    }
    .doc-item:last-child { border-bottom: none; }
    .doc-item > h4 { margin-bottom: 0.35rem; }
    .item-meta {
      margin-top: 0.7rem;
      padding-top: 0.2rem;
    }
    .item-meta ul {
      margin: 0;
      padding-left: 1rem;
    }
    .item-meta li { margin: 0.45rem 0; }
    .member {
      border-left: 3px solid #d2e2db;
      padding: 0.3rem 0.2rem 0.5rem 0.72rem;
      margin: 1rem 0;
    }
    .member h6 { margin: 0.3rem 0 0.35rem; font-size: 1.01rem; }
    .doc-body p:first-child { margin-top: 1rem; }
    .doc-body p { color: #273136; }
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
    .doc-item > h4 code,
    .member h6 code {
      background: transparent;
      padding: 0;
      border-radius: 0;
      font-size: 1em;
    }
    code.sig {
      white-space: pre-wrap;
      line-height: 1.4;
    }
    code.sig .tok-kw { color: #9c4f11; font-weight: 700; }
    code.sig .tok-type { color: #1f5ba8; }
    code.sig .tok-name { color: #0c7a66; font-weight: 650; }
    code.sig .tok-id { color: #1f2933; }
    code.sig .tok-punct { color: #66717c; }
    code.sig .tok-num { color: #7f4a00; }
    pre code {
      display: block;
      padding: 0.8rem;
      overflow-x: auto;
    }
    @media (min-width: 1060px) {
      .layout {
        grid-template-columns: 310px minmax(0, 1fr);
      }
      .sidebar {
        display: block;
        align-self: start;
      }
      .toc-top { display: none; }
      .content { padding: 1.2rem 1.6rem 1.8rem; }
    }
    @media (max-width: 820px) {
      body { padding: 0.65rem; }
      .hero { padding: 1.15rem 1rem; }
      .content { padding: 0.85rem 0.9rem 1.2rem; }
      .module-section { padding: 0.85rem 0 0.75rem; }
      .module-section > header { margin-left: 0; margin-right: 0; }
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
        <h3>Docs Index</h3>
        <nav class="sidebar-nav">
          <ul>
            ${sidebar}
          </ul>
        </nav>
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
