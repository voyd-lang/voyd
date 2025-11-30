import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  Diagnostic,
  DiagnosticSeverity,
  SourceSpan,
} from "@voyd/compiler-next/diagnostics/index";

type Position = { index: number; line: number; column: number };

type SpanContext = {
  path: string;
  start: Position;
  end: Position;
  lineText?: string;
};

type Colorizer = {
  severityLabel: (severity: DiagnosticSeverity) => string;
  pointer: (severity: DiagnosticSeverity, text: string) => string;
  accent: (text: string) => string;
  muted: (text: string) => string;
};

const clampIndex = (value: number, max: number): number => {
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
};

const createLineStarts = (source: string): number[] => {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
};

const lineIndexFor = (starts: number[], index: number): number => {
  let line = 0;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] > index) break;
    line = i;
  }
  return line;
};

const positionAt = (starts: number[], index: number): Position => {
  const line = lineIndexFor(starts, index);
  const lineStart = starts[line] ?? 0;
  return { index, line: line + 1, column: index - lineStart };
};

const lineTextAt = ({
  source,
  lineNumber,
}: {
  source: string;
  lineNumber: number;
}): string | undefined => source.split("\n")[lineNumber - 1];

const resolveSpanContext = (span: SourceSpan): SpanContext | undefined => {
  const path = isAbsolute(span.file) ? span.file : resolve(span.file);
  let source: string;

  try {
    source = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const lineStarts = createLineStarts(source);
  const boundedStart = clampIndex(span.start, source.length);
  const boundedEnd = clampIndex(span.end, source.length);
  const start = positionAt(lineStarts, boundedStart);
  const end = positionAt(lineStarts, Math.max(boundedEnd, boundedStart));
  const lineText = lineTextAt({ source, lineNumber: start.line });

  return { path, start, end, lineText };
};

const colorForSeverity = (
  severity: DiagnosticSeverity
): ((text: string) => string) => {
  switch (severity) {
    case "warning":
      return (text) => `\u001B[33m${text}\u001B[0m`;
    case "note":
      return (text) => `\u001B[36m${text}\u001B[0m`;
    default:
      return (text) => `\u001B[31m${text}\u001B[0m`;
  }
};

const createColorizer = (enabled: boolean): Colorizer => {
  if (!enabled) {
    const identity = (text: string) => text;
    return {
      severityLabel: (severity) => severity.toUpperCase(),
      pointer: (_severity, text) => text,
      accent: identity,
      muted: identity,
    };
  }

  const bold = (text: string) => `\u001B[1m${text}\u001B[0m`;
  const dim = (text: string) => `\u001B[2m${text}\u001B[0m`;
  return {
    severityLabel: (severity) =>
      bold(colorForSeverity(severity)(severity.toUpperCase())),
    pointer: (severity, text) => colorForSeverity(severity)(text),
    accent: (text) => `\u001B[35m${text}\u001B[0m`,
    muted: dim,
  };
};

const formatSnippet = ({
  diagnostic,
  span,
  color,
}: {
  diagnostic: Diagnostic;
  span: SpanContext;
  color: Colorizer;
}): string | undefined => {
  if (!span.lineText) return undefined;

  const { lineText, start, end } = span;
  const lineStartIndex = start.index - start.column;
  const lineEndIndex = lineStartIndex + lineText.length;
  const highlightStart = Math.min(Math.max(start.index, lineStartIndex), lineEndIndex);
  const highlightEnd = Math.min(Math.max(end.index, highlightStart + 1), lineEndIndex);
  const pointerLength = Math.max(1, highlightEnd - highlightStart);
  const pointerOffset = start.column;
  const gutter = `${start.line}`;
  const padding = " ".repeat(gutter.length);
  const marker = `${" ".repeat(pointerOffset)}${color.pointer(
    diagnostic.severity ?? "error",
    "^".repeat(pointerLength)
  )}`;
  const message = color.muted(diagnostic.message);

  return [
    `${padding} |`,
    `${gutter} | ${lineText}`,
    `${padding} | ${marker} ${message}`,
  ].join("\n");
};

const formatLocation = ({
  span,
  context,
}: {
  span: SourceSpan;
  context?: SpanContext;
}): string => {
  if (context) {
    return `${context.path}:${context.start.line}:${context.start.column + 1}`;
  }
  const path = isAbsolute(span.file) ? span.file : resolve(span.file);
  return `${path}:${span.start}-${span.end}`;
};

export const formatCliDiagnostic = (
  diagnostic: Diagnostic,
  options: { color?: boolean } = {}
): string => {
  const color = createColorizer(options.color ?? true);
  const context = resolveSpanContext(diagnostic.span);
  const location = formatLocation({ span: diagnostic.span, context });
  const phase = diagnostic.phase ? ` [${diagnostic.phase}]` : "";
  const header = `${location} ${color.severityLabel(
    diagnostic.severity ?? "error"
  )}${phase} ${color.accent(diagnostic.code)}: ${diagnostic.message}`;
  const snippet = context ? formatSnippet({ diagnostic, span: context, color }) : undefined;

  return [header, snippet].filter(Boolean).join("\n");
};
