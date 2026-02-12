import { ReaderMacro } from "./types.js";
import { type Expr, isForm } from "../ast/index.js";
import { identifier, string } from "../ast/init-helpers.js";
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

export const stringMacro: ReaderMacro = {
  match: (t) => t.value === '"' || t.value === "'",
  macro: (file, { token }) => {
    const startChar = token.value;
    token.value = "";
    while (file.hasCharacters) {
      const next = file.consumeChar();

      if (next === "\\") {
        token.addChar(next);
        token.addChar(file.consumeChar());
        continue;
      }

      if (next === startChar) {
        break;
      }

      token.addChar(next);
    }
    token.setEndLocationToStartOf(file.currentSourceLocation());

    if (startChar === "'") {
      return identifier(token.value)
        .setLocation(token.location)
        .setIsQuoted(true);
    }

    const generated = string(token.value).setLocation(token.location);
    assignMissingGeneratedLocations(generated, generated.location);
    return generated;
  },
};
