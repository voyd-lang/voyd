import { describe, expect, it } from "vitest";
import adapter, { renderMarkdown } from "./adapter.js";

describe("markdown package adapter", () => {
  it("renders common Markdown through the package contract", () => {
    const rendered = renderMarkdown("# Wiki\n\n**Voyd**");
    expect(rendered.nodes.some((node) => node.tag === "h1")).toBe(true);
    expect(rendered.nodes.some((node) => node.tag === "strong")).toBe(true);
    expect(rendered.nodes.some((node) => node.value === "Voyd")).toBe(true);
    expect(adapter.contract.packageName).toBe("@voyd-lang/markdown");
  });

  it("escapes raw HTML and blocks active URL schemes", () => {
    const rendered = renderMarkdown(
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,x)',
    );

    expect(rendered.nodes.some((node) => node.tag === "script")).toBe(false);
    expect(rendered.nodes.some((node) => node.value.includes("<script>"))).toBe(true);
    const attrs = rendered.nodes.flatMap((node) => node.attrs);
    expect(attrs.some((attr) => attr.value.startsWith("javascript:"))).toBe(false);
    expect(attrs.some((attr) => attr.value.startsWith("data:"))).toBe(false);
    expect(attrs.filter((attr) => attr.name === "href" || attr.name === "src").map((attr) => attr.value)).toEqual(["#", "#"]);
  });

  it("renders GFM tables into static table nodes", () => {
    const rendered = renderMarkdown("| A | B |\n|:---|---:|\n| 1 | 2 |");
    expect(rendered.nodes.some((node) => node.tag === "table")).toBe(true);
    expect(rendered.nodes.filter((node) => node.tag === "th")).toHaveLength(2);
    expect(rendered.nodes.filter((node) => node.tag === "td")).toHaveLength(2);
    expect(rendered.nodes.find((node) => node.tag === "th")?.attrs).toContainEqual({ name: "align", value: "left" });
  });

  it("preserves fenced-code language metadata", () => {
    const rendered = renderMarkdown("```js\nconst answer = 42;\n```");
    expect(rendered.nodes.find((node) => node.tag === "code")?.attrs)
      .toContainEqual({ name: "class", value: "language-js" });
  });

  it("preserves GFM task-list checked state", () => {
    const rendered = renderMarkdown("- [x] done\n- [ ] todo");
    const inputs = rendered.nodes.filter((node) => node.tag === "input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.attrs.some((attr) => attr.name === "checked")).toBe(true);
    expect(inputs[1]?.attrs.some((attr) => attr.name === "checked")).toBe(false);
  });

  it("preserves paragraph structure in loose lists", () => {
    const rendered = renderMarkdown("- first\n\n- second");
    const paragraphs = rendered.nodes.filter((node) => node.tag === "p");
    expect(paragraphs).toHaveLength(2);
  });

  it("decodes Marked entities before creating inert text and URL attributes", () => {
    const rendered = renderMarkdown("2 < 3 &amp; 4 &copy; &nbsp; &#0; [link &amp; label](https://example.test/?a=1&amp;b=2)");
    expect(rendered.nodes.some((node) => node.value.includes("2 < 3 & 4"))).toBe(true);
    expect(rendered.nodes.some((node) => node.value.includes("link & label"))).toBe(true);
    expect(rendered.nodes.some((node) => node.value.includes("© \u00a0 �"))).toBe(true);
    expect(rendered.nodes.flatMap((node) => node.attrs)).toContainEqual({
      name: "href",
      value: "https://example.test/?a=1&b=2",
    });
  });

  it("rejects hostile nesting with a controlled error", () => {
    expect(() => renderMarkdown(`${"> ".repeat(5000)}x`))
      .toThrow(/Markdown nesting exceeds/);
  });
});
