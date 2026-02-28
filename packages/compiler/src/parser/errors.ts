import type { SourceLocation } from "./ast/syntax.js";

export class ParserSyntaxError extends Error {
  readonly location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(message);
    this.name = "ParserSyntaxError";
    this.location = location?.clone();
  }
}

export const parserErrorLocation = (
  error: unknown,
): SourceLocation | undefined =>
  error instanceof ParserSyntaxError ? error.location : undefined;

