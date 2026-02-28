import { ReaderMacro } from "./types.js";
import { CharStream } from "../char-stream.js";
import { type Expr, Form, call, identifier, isForm, string } from "../ast/index.js";
import type { SourceLocation } from "../ast/syntax.js";

const assignMissingGeneratedLocations = (
  expr: Expr,
  fallback?: SourceLocation
): void => {
  const location = expr.location ?? fallback;
  if (!location) {
    return;
  }

  if (!expr.location) {
    expr.setLocation(location.clone());
  }

  if (!isForm(expr)) {
    return;
  }

  expr.toArray().forEach((child) =>
    assignMissingGeneratedLocations(child, location)
  );
};

type StringSegment =
  | { kind: "text"; value: string }
  | { kind: "expr"; value: Expr };

const stringMethodCall = ({
  target,
  method,
  args = [],
}: {
  target: Expr;
  method: string;
  args?: Expr[];
}): Expr =>
  call(identifier("."), target, new Form([identifier(method), ...args]).toCall());

const buildInterpolatedStringExpr = (
  segments: readonly StringSegment[]
): Expr => {
  const parts = segments.flatMap((segment) =>
    segment.kind === "text"
      ? segment.value.length > 0
        ? [string(segment.value)]
        : []
      : [segment.value]
  );

  if (parts.length === 0) {
    return string("");
  }

  return parts
    .slice(1)
    .reduce(
      (left, right) =>
        stringMethodCall({
          target: left,
          method: "concat",
          args: [right],
        }),
      parts[0]!
    );
};

const consumeQuotedIdentifier = ({
  file,
  token,
  quote,
}: {
  file: CharStream;
  token: { value: string; addChar: (value: string) => void };
  quote: string;
}): string => {
  token.value = "";
  while (file.hasCharacters) {
    const next = file.consumeChar();

    if (next === "\\") {
      token.addChar(next);
      token.addChar(file.consumeChar());
      continue;
    }

    if (next === quote) {
      break;
    }

    token.addChar(next);
  }

  return token.value;
};

const consumeDoubleQuotedSegments = ({
  file,
  reader,
}: {
  file: CharStream;
  reader: (file: CharStream, terminator?: string) => Form;
}): { value: string; segments: StringSegment[]; hasInterpolation: boolean } => {
  const segments: StringSegment[] = [];
  let value = "";
  let buffer = "";
  let hasInterpolation = false;

  const pushBuffer = (): void => {
    if (buffer.length === 0) {
      return;
    }
    segments.push({ kind: "text", value: buffer });
    buffer = "";
  };

  while (file.hasCharacters) {
    const next = file.consumeChar();

    if (next === "\\") {
      const escaped = file.consumeChar();
      if (escaped === "$" && file.next === "{") {
        file.consumeChar();
        buffer += "${";
        value += "${";
        continue;
      }
      buffer += `${next}${escaped}`;
      value += `${next}${escaped}`;
      continue;
    }

    if (next === '"') {
      break;
    }

    if (next === "$" && file.next === "{") {
      file.consumeChar();
      pushBuffer();
      segments.push({ kind: "expr", value: reader(file, "}").unwrap() });
      hasInterpolation = true;
      continue;
    }

    buffer += next;
    value += next;
  }

  if (!hasInterpolation || buffer.length > 0) {
    segments.push({ kind: "text", value: buffer });
  }

  return { value, segments, hasInterpolation };
};

export const stringMacro: ReaderMacro = {
  match: (t) => t.value === '"' || t.value === "'",
  macro: (file, { token, reader }) => {
    const startChar = token.value;

    const { value, segments, hasInterpolation } =
      startChar === "'"
        ? {
            value: consumeQuotedIdentifier({
              file,
              token,
              quote: startChar,
            }),
            segments: [] as StringSegment[],
            hasInterpolation: false,
          }
        : consumeDoubleQuotedSegments({ file, reader });

    token.value = value;
    token.setEndLocationToStartOf(file.currentSourceLocation());

    if (startChar === "'") {
      return identifier(token.value)
        .setLocation(token.location)
        .setIsQuoted(true);
    }

    const generated = (
      hasInterpolation ? buildInterpolatedStringExpr(segments) : string(token.value)
    ).setLocation(token.location);
    assignMissingGeneratedLocations(generated, generated.location);
    return generated;
  },
};
