import { useMemo, useState } from "react";
import { shikiToMonaco } from "@shikijs/monaco";
import { highlighter } from "./CodeBlock";
import { Editor } from "@monaco-editor/react";

export interface VoydEditorProps {
  value?: string;
  height?: string | number;
  className?: string;
  onChange?: (code: string | undefined) => void;
  onPlay?: (code: string | undefined) => void;
  isLoading?: boolean;
}

export default function VoydEditor({
  value = "",
  height = "100%",
  className,
  onChange,
  onPlay,
  isLoading = false,
}: VoydEditorProps) {
  const [code, setCode] = useState(value);

  // Initialize modern-monaco (manual mode) and create the editor

  const play = useMemo(
    () => () => {
      onPlay?.(code);
    },
    [onPlay, code]
  );

  return (
    <div className={"size-full relative " + (className ?? "")}>
      <Editor
        className="size-full"
        height={height}
        defaultLanguage="voyd"
        defaultValue={value}
        options={{
          minimap: { enabled: false },
        }}
        onMount={(_, monaco) => {
          monaco.languages.register({ id: "voyd" });
          shikiToMonaco(highlighter, monaco as any);
        }}
        onChange={(v) => {
          if (v) setCode(v);
          if (onChange) onChange(v);
        }}
      />
      <button
        type="button"
        onClick={play}
        disabled={isLoading}
        aria-busy={isLoading}
        className="absolute bottom-2 right-2 inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
        aria-label={isLoading ? "Compiling" : "Play"}
        title={isLoading ? "Compiling" : "Play"}
      >
        {isLoading ? (
          <span
            aria-hidden
            className="inline-block size-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin"
          />
        ) : (
          <span aria-hidden className="text-green-400">▶︎</span>
        )}
        <span>{isLoading ? "Compiling…" : "Play"}</span>
      </button>
    </div>
  );
}
