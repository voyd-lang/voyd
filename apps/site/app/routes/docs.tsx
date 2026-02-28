import type { Route } from "./+types/docs";
import {
  getReferenceDoc,
  referenceNav,
  type ReferenceNavItem,
} from "@voyd/reference";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import CodeBlock from "../components/CodeBlock";
import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useHref, useSearchParams } from "react-router";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Voyd Documentation" },
    {
      name: "description",
      content: "Documentation for the Voyd programming language.",
    },
  ];
}

type Heading = { id: string; text: string; level: number };

type NavLeafNode = {
  kind: "doc";
  slug: string;
  title: string;
  order?: number;
};

type NavFolderNode = {
  kind: "folder";
  path: string;
  title: string;
  slug?: string;
  order?: number;
  children: NavNode[];
};

type NavNode = NavLeafNode | NavFolderNode;

type MutableNavFolder = {
  path: string;
  title: string;
  slug?: string;
  order?: number;
  folders: Map<string, MutableNavFolder>;
  docs: NavLeafNode[];
};

const toTitleCase = (segment: string) =>
  segment
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

const sortNodes = (a: NavNode, b: NavNode) => {
  const aOrder = a.order ?? Number.POSITIVE_INFINITY;
  const bOrder = b.order ?? Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.title.localeCompare(b.title);
};

const buildNavTree = (items: ReferenceNavItem[]) => {
  const parentSlugs = new Set<string>();
  items.forEach(({ slug }) => {
    if (!slug) return;
    const parts = slug.split("/");
    if (parts.length < 2) return;
    parts.slice(1).forEach((_, index) => {
      parentSlugs.add(parts.slice(0, index + 1).join("/"));
    });
  });

  const root: MutableNavFolder = {
    path: "",
    title: "Documentation",
    folders: new Map<string, MutableNavFolder>(),
    docs: [],
  };

  const getOrCreateFolder = ({
    parent,
    segment,
    path,
  }: {
    parent: MutableNavFolder;
    segment: string;
    path: string;
  }) => {
    const existing = parent.folders.get(segment);
    if (existing) return existing;

    const created: MutableNavFolder = {
      path,
      title: toTitleCase(segment),
      folders: new Map<string, MutableNavFolder>(),
      docs: [],
    };
    parent.folders.set(segment, created);
    return created;
  };

  items.forEach((item) => {
    if (item.slug === "") {
      root.slug = "";
      root.title = item.title;
      root.order = item.order;
      return;
    }

    const segments = item.slug.split("/").filter(Boolean);
    let cursor = root;

    segments.forEach((segment, index) => {
      const segmentPath = segments.slice(0, index + 1).join("/");
      const isLeaf = index === segments.length - 1;
      const isFolderDoc = parentSlugs.has(segmentPath);

      if (isLeaf && !isFolderDoc) {
        cursor.docs.push({
          kind: "doc",
          slug: item.slug,
          title: item.title,
          order: item.order,
        });
        return;
      }

      const folder = getOrCreateFolder({
        parent: cursor,
        segment,
        path: segmentPath,
      });

      if (!isLeaf) {
        cursor = folder;
        return;
      }

      if (isFolderDoc) {
        folder.slug = item.slug;
        folder.title = item.title;
        folder.order = item.order;
      }
    });
  });

  const folderTree = (folder: MutableNavFolder): NavFolderNode => {
    const childFolders = Array.from(folder.folders.values()).map(folderTree);
    const children = [...childFolders, ...folder.docs].sort(sortNodes);
    return {
      kind: "folder",
      path: folder.path,
      title: folder.title,
      slug: folder.slug,
      order: folder.order,
      children,
    };
  };

  return folderTree(root);
};

const NavItemLink = ({
  title,
  href,
  isActive,
  depth,
  onClick,
}: {
  title: string;
  href: string;
  isActive: boolean;
  depth: number;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) => (
  <a
    href={href}
    onClick={onClick}
    className={[
      "block rounded px-2 py-1 text-sm leading-5 transition-colors",
      "hover:bg-[var(--site-surface-soft)]",
      isActive
        ? "bg-[var(--site-surface-soft)] font-semibold text-[var(--foreground)]"
        : "text-[var(--site-text-muted)]",
    ].join(" ")}
    style={{ marginLeft: `${depth * 12}px` }}
  >
    {title}
  </a>
);

const flattenText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(flattenText).join("");
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
};

const unwrapTickWrappedContent = (value: string): string => {
  let current = value.trim();
  while (true) {
    const match = current.match(/^(`+)([\s\S]*?)\1$/);
    if (!match) return current;
    current = (match[2] ?? "").trim();
  }
};

export default function Docs() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const navRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const docsPath = useHref("/docs");

  const requestedSlug = searchParams.get("p") ?? "";
  const doc = getReferenceDoc(requestedSlug) ?? getReferenceDoc("")!;
  const navTree = useMemo(() => buildNavTree(referenceNav), []);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  );

  const setDocSlug = (slug: string) => {
    if (slug) {
      setSearchParams({ p: slug });
      return;
    }
    setSearchParams({});
  };

  const getDocHref = (slug: string) =>
    slug ? `?p=${encodeURIComponent(slug)}` : docsPath;

  // Build headings (h2–h3) from the rendered DOM.
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;

    const nodes = Array.from(
      root.querySelectorAll("h2, h3")
    ) as HTMLHeadingElement[];

    const list: Heading[] = nodes
      .map((h) => {
        const level = Number(h.tagName.slice(1)); // 2, or 3
        const text = (h.textContent || "").trim();
        const id = h.id || "";
        return id && text ? { id, text, level } : null;
      })
      .filter(Boolean) as Heading[];

    setHeadings(list);
  }, [doc.body]);

  // Scroll spy: highlight active heading in the nav.
  useEffect(() => {
    const root = articleRef.current;
    if (!root || headings.length === 0) return;

    const targets = Array.from(root.querySelectorAll("h2, h3"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).id;
          const nav = navRef.current;
          if (!nav || !id) continue;

          nav.querySelectorAll("a").forEach((a) => {
            if (a.getAttribute("href") === `#${id}`) {
              a.classList.add("text-[var(--foreground)]", "font-semibold");
            } else {
              a.classList.remove("text-[var(--foreground)]", "font-semibold");
            }
          });
        }
      },
      { rootMargin: "0px 0px -80% 0px" }
    );

    targets.forEach((el) => observer.observe(el));
    return () => targets.forEach((el) => observer.unobserve(el));
  }, [headings]);

  useEffect(() => {
    if (!doc.slug) return;
    const segments = doc.slug.split("/").filter(Boolean);
    if (segments.length < 2) return;

    setExpandedFolders((current) => {
      const next = new Set(current);
      segments.slice(0, -1).forEach((_, index) => {
        next.add(segments.slice(0, index + 1).join("/"));
      });
      return next;
    });
  }, [doc.slug]);

  const components: Components = {
    code({ className, children }) {
      const languageMatch = /language-(\w+)/.exec(className || "");
      const rawContent = flattenText(children).replace(/\r\n/g, "\n");
      const unwrapped = unwrapTickWrappedContent(rawContent);

      if (languageMatch) {
        const lang = languageMatch[1] === "rust" ? "voyd" : languageMatch[1];
        return <CodeBlock code={unwrapped.replace(/\n$/, "")} lang={lang} />;
      }

      if (unwrapped.includes("\n")) {
        const multilineMatch = unwrapped.match(/^([A-Za-z0-9_-]+)\n([\s\S]*)$/);
        const potentialLang = multilineMatch?.[1]?.toLowerCase() ?? "";
        const supportedLang = /^(voyd|rust|bash|javascript|typescript|tsx)$/.test(
          potentialLang,
        );
        const lang = supportedLang
          ? potentialLang === "rust"
            ? "voyd"
            : potentialLang
          : "voyd";
        const code = supportedLang
          ? (multilineMatch?.[2] ?? unwrapped)
          : unwrapped;
        return <CodeBlock code={code.replace(/\n$/, "")} lang={lang} />;
      }

      return (
        <code className="rounded bg-[var(--site-surface-soft)] px-1.5 py-0.5 text-[0.95em] text-[var(--foreground)]">
          {unwrapped}
        </code>
      );
    },
    pre({ node: _node, children, ...props }) {
      const childNodes = Array.isArray(children) ? children : [children];
      const firstChild = childNodes[0];

      if (isValidElement<{ className?: string; children?: unknown }>(firstChild)) {
        if (
          typeof firstChild.props === "object" &&
          firstChild.props !== null &&
          "code" in firstChild.props &&
          "lang" in firstChild.props
        ) {
          return firstChild;
        }

        const className =
          typeof firstChild.props.className === "string"
            ? firstChild.props.className
            : "";
        const match = /language-(\w+)/.exec(className);
        const lang = match ? match[1] : "voyd";
        const code = flattenText(firstChild.props.children).replace(/\n$/, "");

        return <CodeBlock code={code} lang={lang === "rust" ? "voyd" : lang} />;
      }

      return (
        <pre className="not-prose overflow-x-auto" {...props}>
          {children}
        </pre>
      );
    },
  };

  const renderNavNode = (node: NavNode, depth = 0): ReactNode => {
    if (node.kind === "doc") {
      return (
        <NavItemLink
          key={node.slug}
          title={node.title}
          href={getDocHref(node.slug)}
          isActive={node.slug === doc.slug}
          depth={depth}
          onClick={(event) => {
            event.preventDefault();
            setDocSlug(node.slug);
          }}
        />
      );
    }

    if (!node.path) {
      const rootSlug = node.slug;
      return (
        <>
          {rootSlug !== undefined ? (
            <NavItemLink
              title={node.title}
              href={getDocHref(rootSlug)}
              isActive={doc.slug === rootSlug}
              depth={depth}
              onClick={(event) => {
                event.preventDefault();
                setDocSlug(rootSlug);
              }}
            />
          ) : null}
          {node.children.map((child) => renderNavNode(child, depth))}
        </>
      );
    }

    const hasChildren = node.children.length > 0;
    const isOpen = expandedFolders.has(node.path);
    const folderActive =
      node.slug === doc.slug || doc.slug.startsWith(`${node.path}/`);
    const folderSlug = node.slug;

    return (
      <div key={node.path} className="space-y-1">
        <div
          className="flex items-center gap-1 rounded px-1 py-0.5"
          style={{ marginLeft: `${depth * 12}px` }}
        >
          <button
            type="button"
            className={[
              "inline-flex size-5 items-center justify-center rounded border text-[11px] font-bold transition",
              "border-[var(--site-border)] bg-[var(--site-surface)] shadow-sm hover:bg-[var(--site-surface-soft)]",
              hasChildren
                ? "text-[var(--foreground)]"
                : "pointer-events-none opacity-0",
            ].join(" ")}
            aria-label={isOpen ? `Collapse ${node.title}` : `Expand ${node.title}`}
            onClick={() =>
              setExpandedFolders((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            {isOpen ? "−" : "+"}
          </button>
          {folderSlug ? (
            <a
              href={getDocHref(folderSlug)}
              onClick={(event) => {
                event.preventDefault();
                setDocSlug(folderSlug);
              }}
              className={[
                "min-w-0 truncate rounded px-1 py-1 text-sm leading-5 transition-colors",
                "hover:bg-[var(--site-surface-soft)]",
                folderActive
                  ? "font-semibold text-[var(--foreground)]"
                  : "text-[var(--site-text-muted)]",
              ].join(" ")}
            >
              {node.title}
            </a>
          ) : (
            <span
              className={[
                "min-w-0 truncate px-1 py-1 text-sm leading-5",
                folderActive
                  ? "font-semibold text-[var(--foreground)]"
                  : "text-[var(--site-text-muted)]",
              ].join(" ")}
            >
              {node.title}
            </span>
          )}
        </div>
        {isOpen ? node.children.map((child) => renderNavNode(child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl gap-8 px-4 py-16 text-[var(--foreground)]">
      <aside className="sticky top-20 hidden h-[calc(100vh-5rem)] w-64 flex-shrink-0 overflow-auto pr-2 md:block">
        <div className="space-y-6">
          <div className="space-y-2">
            <p className="m-0 px-2 text-[11px] font-bold tracking-[0.08em] text-[var(--site-text-muted)] uppercase">
              Docs
            </p>
            <nav className="space-y-1">{renderNavNode(navTree)}</nav>
          </div>

          <div className="space-y-2">
            <p className="m-0 px-2 text-[11px] font-bold tracking-[0.08em] text-[var(--site-text-muted)] uppercase">
              On this page
            </p>
            <nav ref={navRef} className="space-y-1 text-xs text-[var(--site-text-muted)]">
              {headings.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.id}`}
                  className={[
                    "block rounded px-2 py-1 leading-5 transition-colors hover:bg-[var(--site-surface-soft)] hover:text-[var(--foreground)]",
                    h.level === 3 ? "ml-3" : "",
                  ].join(" ")}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </aside>

      <article
        ref={articleRef}
        className="prose flex-1 max-w-3xl min-w-0 space-y-8 text-[var(--foreground)] prose-headings:text-[var(--foreground)] prose-p:text-[var(--foreground)] prose-li:text-[var(--foreground)] prose-strong:text-[var(--foreground)] prose-a:text-[var(--foreground)] prose-a:underline prose-a:decoration-[var(--site-text-muted)] prose-blockquote:text-[var(--site-text-muted)] prose-hr:border-[var(--site-border)] prose-code:text-[var(--foreground)] prose-code:before:content-none prose-code:after:content-none"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          components={components}
        >
          {doc.body}
        </ReactMarkdown>
      </article>
    </main>
  );
}
