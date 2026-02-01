import type { Route } from "./+types/docs";
import { getReferenceDoc, referenceNav } from "@voyd/reference";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import CodeBlock from "../components/CodeBlock";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

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

export default function Docs() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const navRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const requestedSlug = searchParams.get("p") ?? "";
  const doc = getReferenceDoc(requestedSlug) ?? getReferenceDoc("")!;

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
              a.classList.add("text-blue-400", "font-medium");
            } else {
              a.classList.remove("text-blue-400", "font-medium");
            }
          });
        }
      },
      { rootMargin: "0px 0px -80% 0px" }
    );

    targets.forEach((el) => observer.observe(el));
    return () => targets.forEach((el) => observer.unobserve(el));
  }, [headings]);

  const components: Components = {
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match ? match[1] : "voyd";
      return (
        <CodeBlock
          code={String(children).replace(/\n$/, "")}
          lang={lang === "rust" ? "voyd" : lang}
        />
      );
    },
    pre({ node: _node, ...props }) {
      return <pre className="not-prose" {...props} />;
    },
  };

  return (
    <main className="flex w-full max-w-5xl mx-auto py-16 px-4 gap-8">
      <aside className="hidden md:block w-64 flex-shrink-0 sticky top-20 h-[calc(100vh-5rem)] overflow-auto pr-2">
        <div className="space-y-6">
          <nav className="space-y-1 text-sm">
            {referenceNav.map((p) => {
              const depth = p.slug ? p.slug.split("/").length - 1 : 0;
              const isActive = p.slug === doc.slug;
              const href = p.slug ? `?p=${encodeURIComponent(p.slug)}` : "/docs";
              return (
                <a
                  key={p.slug || "index"}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (p.slug) setSearchParams({ p: p.slug });
                    else setSearchParams({});
                  }}
                  className={[
                    "block rounded px-2 py-1 hover:bg-gray-800/60",
                    isActive ? "bg-gray-800/60 text-blue-300" : "",
                    depth ? "ml-3" : "",
                  ].join(" ")}
                >
                  {p.title}
                </a>
              );
            })}
          </nav>

          <nav ref={navRef} className="space-y-2 text-xs text-gray-300">
            {headings.map((h) => (
              <a
                key={h.id}
                href={`#${h.id}`}
                className={[
                  "block hover:underline",
                  h.level === 3 ? "ml-4" : "",
                ].join(" ")}
              >
                {h.text}
              </a>
            ))}
          </nav>
        </div>
      </aside>

      <article
        ref={articleRef}
        className="flex-1 min-w-0 max-w-3xl space-y-8 prose prose-invert"
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
