import { describe, expect, it } from "vitest";
import { ParserSyntaxError } from "../errors.js";
import { parse } from "../parser.js";

describe("html parser errors", () => {
  it("throws parser syntax errors with source locations for malformed tags", () => {
    const source = `fn main() -> i32\n  <div class="open"\n`;
    let caught: unknown;

    try {
      parse(source, "/proj/src/main.voyd");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ParserSyntaxError);
    if (!(caught instanceof ParserSyntaxError)) {
      return;
    }

    expect(caught.message).toBe("Malformed tag");
    expect(caught.location?.filePath).toBe("/proj/src/main.voyd");
    expect(caught.location?.startLine).toBeGreaterThanOrEqual(2);
    expect(caught.location?.startColumn).toBeGreaterThanOrEqual(0);
  });
});
