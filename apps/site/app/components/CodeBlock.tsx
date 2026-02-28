import type { FC } from "react";
import { createHighlighter, type LanguageInput } from "shiki";
import voydGrammar from "../../../vscode/syntaxes/voyd.tmLanguage.json";

export const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: [
    "bash",
    "javascript",
    "typescript",
    "tsx",
    {
      ...(voydGrammar as unknown as LanguageInput),
      name: "voyd",
      aliases: ["Voyd"],
    } as LanguageInput,
  ],
});

interface Props {
  code: string;
  lang?: string;
}

const CodeBlock: FC<Props> = ({ code, lang = "voyd" }) => {
  const html = highlighter.codeToHtml(code.trim(), {
    lang,
    theme: "github-dark",
    transformers: [
      {
        pre(node) {
          this.addClassToHast(
            node,
            "not-prose size-full max-w-full rounded p-4 overflow-x-auto"
          );
        },
      },
    ],
  });

  function copy() {
    navigator.clipboard.writeText(code);
  }

  return (
    <div className="relative w-full">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <button
        onClick={copy}
        className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d]"
      >
        Copy
      </button>
    </div>
  );
};

export default CodeBlock;
