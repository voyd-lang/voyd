type VisibilityLike = {
  level?: string;
};

type ParameterLike = {
  name: string;
  label?: string;
  optional?: boolean;
  typeExpr?: unknown;
  documentation?: string;
};

type FunctionLike = {
  id: number;
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<ParameterLike>;
  returnTypeExpr?: unknown;
  effectTypeExpr?: unknown;
  documentation?: string;
};

type TypeAliasLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  target: unknown;
  documentation?: string;
};

type ObjectLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  baseTypeExpr?: unknown;
  fields: ReadonlyArray<{
    name: string;
    typeExpr: unknown;
    documentation?: string;
  }>;
  documentation?: string;
};

type TraitLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  methods: ReadonlyArray<{
    name: string;
    params: ReadonlyArray<ParameterLike>;
    returnTypeExpr?: unknown;
    effectTypeExpr?: unknown;
    documentation?: string;
  }>;
  documentation?: string;
};

type ImplLike = {
  id: number;
  visibility: VisibilityLike;
  target: unknown;
  trait?: unknown;
  typeParameters?: ReadonlyArray<{ name: string }>;
  methods: ReadonlyArray<FunctionLike>;
  documentation?: string;
};

type ModuleDocumentationLike = {
  module?: string;
};

type ModuleNodeLike = {
  id: string;
  docs?: ModuleDocumentationLike;
};

type SemanticsLike = {
  binding: {
    packageId: string;
    functions: ReadonlyArray<FunctionLike>;
    typeAliases: ReadonlyArray<TypeAliasLike>;
    objects: ReadonlyArray<ObjectLike>;
    traits: ReadonlyArray<TraitLike>;
    impls: ReadonlyArray<ImplLike>;
  };
};

type GraphLike = {
  entry: string;
  modules: ReadonlyMap<string, ModuleNodeLike>;
};

type DocItem = {
  kind: "mod" | "fn" | "type" | "obj" | "trait" | "impl";
  fqn: string;
  signature: string;
  documentation?: string;
  parameterDocs?: Array<{ name: string; documentation: string }>;
  memberRows?: Array<{ signature: string; documentation?: string }>;
};

const isPublic = (visibility: VisibilityLike | undefined): boolean =>
  visibility?.level === "public" || visibility?.level === "package";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatTypeExpr = (expr: unknown): string => {
  if (!expr) {
    return "<inferred>";
  }

  if (typeof expr === "string") {
    return expr;
  }

  if (typeof expr === "number" || typeof expr === "boolean") {
    return String(expr);
  }

  if (!expr || typeof expr !== "object") {
    return "<expr>";
  }

  const candidate = expr as {
    syntaxType?: string;
    value?: unknown;
    toArray?: () => unknown[];
  };

  if (
    (candidate.syntaxType === "identifier" ||
      candidate.syntaxType === "int" ||
      candidate.syntaxType === "float" ||
      candidate.syntaxType === "string" ||
      candidate.syntaxType === "bool") &&
    typeof candidate.value === "string"
  ) {
    return candidate.value;
  }

  if (
    (candidate.syntaxType === "form" || candidate.syntaxType === "call-form") &&
    typeof candidate.toArray === "function"
  ) {
    const entries = candidate.toArray();
    return `(${entries.map((entry) => formatTypeExpr(entry)).join(" ")})`;
  }

  return "<expr>";
};

const formatTypeParameters = (
  typeParameters: ReadonlyArray<{ name: string }> | undefined,
): string => {
  if (!typeParameters || typeParameters.length === 0) {
    return "";
  }
  return `<${typeParameters.map((param) => param.name).join(", ")}>`;
};

const formatParameterSignature = (parameter: ParameterLike): string => {
  const optionalMarker = parameter.optional ? "?" : "";
  const typeText = formatTypeExpr(parameter.typeExpr);
  if (parameter.label && parameter.label !== parameter.name) {
    return `${parameter.label} ${parameter.name}${optionalMarker}: ${typeText}`;
  }
  return `${parameter.name}${optionalMarker}: ${typeText}`;
};

const formatFunctionSignature = (fn: {
  name: string;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<ParameterLike>;
  effectTypeExpr?: unknown;
  returnTypeExpr?: unknown;
}): string => {
  const typeParams = formatTypeParameters(fn.typeParameters);
  const params = fn.params.map(formatParameterSignature).join(", ");
  const effectPart = fn.effectTypeExpr
    ? `: ${formatTypeExpr(fn.effectTypeExpr)}`
    : "";
  const returnPart = fn.returnTypeExpr
    ? ` -> ${formatTypeExpr(fn.returnTypeExpr)}`
    : "";
  return `fn ${fn.name}${typeParams}(${params})${effectPart}${returnPart}`;
};

const renderInlineMarkdown = (value: string): string => {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
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
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
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

    paragraph.push(line.trim());
  });

  flushParagraph();
  flushList();
  flushCodeFence();
  return html.join("\n");
};

const sanitizeAnchorSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const collectParameterDocs = (
  params: readonly ParameterLike[],
): Array<{ name: string; documentation: string }> =>
  params.flatMap((param) => {
    if (param.documentation === undefined) {
      return [];
    }
    return [{ name: param.name, documentation: param.documentation }];
  });

const buildDocItems = ({
  graph,
  semantics,
}: {
  graph: GraphLike;
  semantics: ReadonlyMap<string, SemanticsLike>;
}): DocItem[] => {
  const entrySemantics = semantics.get(graph.entry);
  const packageId =
    entrySemantics?.binding.packageId ??
    semantics.values().next().value?.binding?.packageId;

  const items: DocItem[] = [];
  const moduleIds = Array.from(semantics.keys()).sort();

  moduleIds.forEach((moduleId) => {
    const semantic = semantics.get(moduleId);
    if (!semantic) {
      return;
    }
    if (packageId && semantic.binding.packageId !== packageId) {
      return;
    }

    const moduleNode = graph.modules.get(moduleId);
    const moduleDoc = moduleNode?.docs?.module;
    if (moduleDoc !== undefined) {
      items.push({
        kind: "mod",
        fqn: moduleId,
        signature: `mod ${moduleId}`,
        documentation: moduleDoc,
      });
    }

    semantic.binding.functions
      .filter((fn) => isPublic(fn.visibility))
      .forEach((fn) => {
        items.push({
          kind: "fn",
          fqn: `${moduleId}::${fn.name}`,
          signature: formatFunctionSignature(fn),
          documentation: fn.documentation,
          parameterDocs: collectParameterDocs(fn.params),
        });
      });

    semantic.binding.typeAliases
      .filter((alias) => isPublic(alias.visibility))
      .forEach((alias) => {
        items.push({
          kind: "type",
          fqn: `${moduleId}::${alias.name}`,
          signature: `type ${alias.name}${formatTypeParameters(
            alias.typeParameters,
          )} = ${formatTypeExpr(alias.target)}`,
          documentation: alias.documentation,
        });
      });

    semantic.binding.objects
      .filter((objectDecl) => isPublic(objectDecl.visibility))
      .forEach((objectDecl) => {
        items.push({
          kind: "obj",
          fqn: `${moduleId}::${objectDecl.name}`,
          signature: `obj ${objectDecl.name}${formatTypeParameters(
            objectDecl.typeParameters,
          )}${
            objectDecl.baseTypeExpr
              ? `: ${formatTypeExpr(objectDecl.baseTypeExpr)}`
              : ""
          }`,
          documentation: objectDecl.documentation,
          memberRows: objectDecl.fields.map((field) => ({
            signature: `${field.name}: ${formatTypeExpr(field.typeExpr)}`,
            documentation: field.documentation,
          })),
        });
      });

    semantic.binding.traits
      .filter((traitDecl) => isPublic(traitDecl.visibility))
      .forEach((traitDecl) => {
        items.push({
          kind: "trait",
          fqn: `${moduleId}::${traitDecl.name}`,
          signature: `trait ${traitDecl.name}${formatTypeParameters(
            traitDecl.typeParameters,
          )}`,
          documentation: traitDecl.documentation,
          memberRows: traitDecl.methods.map((method) => ({
            signature: formatFunctionSignature(method),
            documentation: method.documentation,
          })),
        });
      });

    semantic.binding.impls
      .filter((implDecl) => isPublic(implDecl.visibility))
      .forEach((implDecl) => {
        items.push({
          kind: "impl",
          fqn: `${moduleId}::impl#${implDecl.id}`,
          signature: `impl${formatTypeParameters(
            implDecl.typeParameters,
          )} ${formatTypeExpr(implDecl.target)}${
            implDecl.trait ? ` for ${formatTypeExpr(implDecl.trait)}` : ""
          }`,
          documentation: implDecl.documentation,
          memberRows: implDecl.methods.map((method) => ({
            signature: formatFunctionSignature(method),
            documentation: method.documentation,
          })),
        });
      });
  });

  return items;
};

export const generateDocumentationHtml = ({
  graph,
  semantics,
}: {
  graph: GraphLike;
  semantics: ReadonlyMap<string, SemanticsLike>;
}): string => {
  const items = buildDocItems({ graph, semantics });
  const title = graph.entry;
  const anchors = new Map<string, string>();
  const anchorCounts = new Map<string, number>();

  items.forEach((item) => {
    const base = sanitizeAnchorSegment(`${item.kind}-${item.fqn}`) || "item";
    const seen = anchorCounts.get(base) ?? 0;
    anchorCounts.set(base, seen + 1);
    anchors.set(item.fqn, seen === 0 ? base : `${base}-${seen}`);
  });

  const tocHtml = items
    .map((item) => {
      const anchor = anchors.get(item.fqn) ?? "item";
      return `<li><a href="#${anchor}"><code>${escapeHtml(
        item.kind,
      )}</code> ${escapeHtml(item.fqn)}</a></li>`;
    })
    .join("\n");

  const sections = items
    .map((item) => {
      const anchor = anchors.get(item.fqn) ?? "item";
      const docsHtml =
        item.documentation !== undefined
          ? `<div class="doc-body">${renderMarkdownToHtml(item.documentation)}</div>`
          : `<p class="doc-missing">No documentation.</p>`;
      const parameterDocsHtml =
        item.parameterDocs && item.parameterDocs.length > 0
          ? `<h4>Parameters</h4><ul>${item.parameterDocs
              .map(
                (param) =>
                  `<li><code>${escapeHtml(
                    param.name,
                  )}</code> ${renderMarkdownToHtml(param.documentation)}</li>`,
              )
              .join("")}</ul>`
          : "";
      const membersHtml =
        item.memberRows && item.memberRows.length > 0
          ? `<h4>Members</h4><ul>${item.memberRows
              .map((member) => {
                const memberDoc = member.documentation
                  ? `<div class="member-doc">${renderMarkdownToHtml(
                      member.documentation,
                    )}</div>`
                  : "";
                return `<li><code>${escapeHtml(
                  member.signature,
                )}</code>${memberDoc}</li>`;
              })
              .join("")}</ul>`
          : "";

      return `<section id="${anchor}">
  <h3><code>${escapeHtml(item.kind)}</code> ${escapeHtml(item.fqn)}</h3>
  <p><strong>Signature:</strong> <code>${escapeHtml(item.signature)}</code></p>
  ${docsHtml}
  ${parameterDocsHtml}
  ${membersHtml}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} Documentation</title>
  <style>
    :root {
      --bg: #f8f9f3;
      --surface: #ffffff;
      --ink: #1f2a2c;
      --muted: #5d6a6f;
      --line: #d7ddd7;
      --accent: #0f766e;
      --accent-soft: #e2f4ef;
      --code-bg: #eef2ec;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem 4rem;
      background: linear-gradient(180deg, #f3f7ec 0%, var(--bg) 100%);
      color: var(--ink);
      font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 24px 40px rgba(15, 23, 42, 0.07);
      overflow: hidden;
    }
    header {
      padding: 1.5rem 1.5rem 1rem;
      border-bottom: 1px solid var(--line);
      background: radial-gradient(circle at top right, var(--accent-soft), #ffffff 52%);
    }
    h1, h2, h3, h4 { margin: 0.6rem 0; line-height: 1.25; }
    h1 { font-size: 1.8rem; }
    h2 { font-size: 1.25rem; color: var(--muted); }
    h3 { margin-top: 0; font-size: 1.15rem; }
    nav, article { padding: 1rem 1.5rem; }
    nav { border-bottom: 1px solid var(--line); background: #f9fcf8; }
    nav ul { margin: 0.65rem 0 0; padding-left: 1.2rem; }
    nav li { margin: 0.2rem 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    section {
      border-bottom: 1px solid var(--line);
      padding: 1.2rem 0;
    }
    section:last-child { border-bottom: none; }
    code {
      font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
      background: var(--code-bg);
      border-radius: 6px;
      padding: 0.12rem 0.35rem;
      font-size: 0.92em;
    }
    pre code {
      display: block;
      overflow-x: auto;
      padding: 0.8rem;
    }
    .doc-missing { color: var(--muted); }
    .doc-body p:first-child { margin-top: 0.25rem; }
    .member-doc p { margin: 0.3rem 0 0; color: var(--muted); }
    @media (max-width: 780px) {
      body { padding: 0.8rem; }
      main { border-radius: 12px; }
      nav, article, header { padding-left: 1rem; padding-right: 1rem; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <h2>Voyd API Documentation</h2>
    </header>
    <nav>
      <h3>Table of Contents</h3>
      <ul>
        ${tocHtml}
      </ul>
    </nav>
    <article>
      ${sections}
    </article>
  </main>
</body>
</html>`;
};
