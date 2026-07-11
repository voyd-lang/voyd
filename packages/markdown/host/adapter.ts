import { marked } from "marked";
import { decodeHTML } from "entities";
import { defineAdapter } from "../generated/voyd-adapter.js";

export type StaticHtmlAttr = { name: string; value: string };
export type StaticHtmlNode = {
  kind: "text" | "element" | "fragment";
  tag: string;
  value: string;
  attrs: StaticHtmlAttr[];
  children: number[];
};
export type StaticHtml = { root: number; nodes: StaticHtmlNode[] };

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  depth?: number;
  href?: string;
  title?: string | null;
  ordered?: boolean;
  start?: number | "";
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
  task?: boolean;
  checked?: boolean;
  lang?: string;
  align?: Array<"left" | "center" | "right" | null>;
  loose?: boolean;
};

type TreeNode = {
  kind: StaticHtmlNode["kind"];
  tag?: string;
  value?: string;
  attrs?: StaticHtmlAttr[];
  children?: TreeNode[];
};

const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_TOKEN_DEPTH = 64;
const MAX_TOKEN_COUNT = 50_000;

export const renderMarkdown = (source: string): StaticHtml => {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`Markdown source exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  const tokens = marked.lexer(source, { gfm: true }) as unknown as MarkdownToken[];
  assertTokenBudget(tokens);
  return flattenTree({ kind: "fragment", children: renderBlocks(tokens) });
};

export default defineAdapter({
  "voyd:markdown/renderer@1": {
    render_static: renderMarkdown,
  },
});

const renderBlocks = (tokens: readonly MarkdownToken[]): TreeNode[] =>
  tokens.flatMap((token) => renderBlock(token));

const assertTokenBudget = (tokens: readonly MarkdownToken[]): void => {
  const pending = tokens.map((token) => ({ token, depth: 1 }));
  let count = 0;
  while (pending.length > 0) {
    const { token, depth } = pending.pop()!;
    count += 1;
    if (depth > MAX_TOKEN_DEPTH) {
      throw new Error(`Markdown nesting exceeds ${MAX_TOKEN_DEPTH} levels`);
    }
    if (count > MAX_TOKEN_COUNT) {
      throw new Error(`Markdown document exceeds ${MAX_TOKEN_COUNT} tokens`);
    }
    const nested = [
      ...(Array.isArray(token.tokens) ? token.tokens : []),
      ...(Array.isArray(token.items) ? token.items : []),
      ...(Array.isArray(token.header) ? token.header : []),
      ...(Array.isArray(token.rows) ? token.rows.flat() : []),
    ];
    nested.forEach((child) => pending.push({ token: child, depth: depth + 1 }));
  }
};

const renderBlock = (token: MarkdownToken): TreeNode[] => {
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return [element(`h${clampHeading(token.depth)}`, renderInline(token))];
    case "paragraph":
      return [element("p", renderInline(token))];
    case "text":
      return token.tokens ? renderInline(token) : [text(decodeHtmlEntities(token.text ?? ""))];
    case "code":
      return [element("pre", [element(
        "code",
        [text(token.text ?? "")],
        token.lang ? [{ name: "class", value: `language-${token.lang.split(/\s+/)[0]}` }] : [],
      )])];
    case "blockquote":
      return [element("blockquote", renderBlocks(token.tokens ?? []))];
    case "list": {
      const tag = token.ordered ? "ol" : "ul";
      const attrs = token.ordered && typeof token.start === "number" && token.start !== 1
        ? [{ name: "start", value: String(token.start) }]
        : [];
      const items = token.items ?? [];
      const listAttrs = items.some((item) => item.task)
        ? [...attrs, { name: "class", value: "contains-task-list" }]
        : attrs;
      return [element(tag, items.map(renderListItem), listAttrs)];
    }
    case "hr":
      return [element("hr")];
    case "table":
      return [renderTable(token)];
    case "html":
      return [text(token.raw ?? token.text ?? "")];
    default:
      return token.tokens ? renderBlocks(token.tokens) : [text(token.text ?? "")];
  }
};

const renderListItem = (token: MarkdownToken): TreeNode =>
  element(
    "li",
    [
      ...(token.task
        ? [element("input", [], [
            { name: "type", value: "checkbox" },
            { name: "disabled", value: "" },
            ...(token.checked ? [{ name: "checked", value: "" }] : []),
          ])]
        : []),
      ...(token.tokens ?? []).flatMap((child) =>
        token.loose && child.type === "text"
          ? [element("p", renderInline(child))]
          : renderBlock(child),
      ),
    ],
    token.task ? [{ name: "class", value: "task-list-item" }] : [],
  );

const renderInline = (token: MarkdownToken): TreeNode[] =>
  (token.tokens ?? [{ type: "text", text: token.text ?? "" }]).flatMap(renderInlineToken);

const renderInlineToken = (token: MarkdownToken): TreeNode[] => {
  switch (token.type) {
    case "text":
    case "escape":
      return [text(decodeHtmlEntities(token.text ?? ""))];
    case "strong":
      return [element("strong", renderInline(token))];
    case "em":
      return [element("em", renderInline(token))];
    case "del":
      return [element("del", renderInline(token))];
    case "codespan":
      return [element("code", [text(token.text ?? "")])];
    case "br":
      return [element("br")];
    case "link":
      return [element("a", renderInline(token), linkAttrs(token, "href"))];
    case "image":
      return [element("img", [], [
        { name: "src", value: safeUrl(decodeHtmlEntities(token.href ?? "")) },
        { name: "alt", value: decodeHtmlEntities(token.text ?? "") },
        ...titleAttr(token.title),
      ])];
    case "html":
      return [text(token.raw ?? token.text ?? "")];
    default:
      return token.tokens ? renderInline(token) : [text(token.text ?? "")];
  }
};

const renderTable = (token: MarkdownToken): TreeNode => {
  const cellAttrs = (index: number): StaticHtmlAttr[] => {
    const alignment = token.align?.[index];
    return alignment ? [{ name: "align", value: alignment }] : [];
  };
  const header = element(
    "thead",
    [element("tr", (token.header ?? []).map((cell, index) =>
      element("th", renderInline(cell), cellAttrs(index)),
    ))],
  );
  const body = element(
    "tbody",
    (token.rows ?? []).map((row) =>
      element("tr", row.map((cell, index) =>
        element("td", renderInline(cell), cellAttrs(index)),
      )),
    ),
  );
  return element("table", [header, body]);
};

const element = (
  tag: string,
  children: TreeNode[] = [],
  attrs: StaticHtmlAttr[] = [],
): TreeNode => ({ kind: "element", tag, attrs, children });

const text = (value: string): TreeNode => ({ kind: "text", value });

const linkAttrs = (token: MarkdownToken, name: string): StaticHtmlAttr[] => [
  { name, value: safeUrl(decodeHtmlEntities(token.href ?? "")) },
  ...titleAttr(token.title),
];

const titleAttr = (title: string | null | undefined): StaticHtmlAttr[] =>
  title ? [{ name: "title", value: decodeHtmlEntities(title) }] : [];

const clampHeading = (value: number | undefined): number =>
  Math.max(1, Math.min(6, value ?? 1));

const flattenTree = (root: TreeNode): StaticHtml => {
  const nodes: StaticHtmlNode[] = [];
  const visit = (node: TreeNode): number => {
    const index = nodes.length;
    nodes.push({ kind: "text", tag: "", value: "", attrs: [], children: [] });
    const children = (node.children ?? []).map(visit);
    nodes[index] = {
      kind: node.kind,
      tag: node.tag ?? "",
      value: node.value ?? "",
      attrs: node.attrs ?? [],
      children,
    };
    return index;
  };
  return { root: visit(root), nodes };
};

const safeUrl = (value: string): string => {
  const normalized = decodeUrlForSchemeCheck(value)
    .replace(/[\u0000-\u0020\u007f]/g, "")
    .toLowerCase();
  return normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:")
    ? "#"
    : value;
};

const decodeUrlForSchemeCheck = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const decodeHtmlEntities = (value: string): string => decodeHTML(value);
