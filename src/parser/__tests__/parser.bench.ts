import { bench } from "vitest";
import { parse } from "../parser.js";
import { BENCH_FILE } from "./fixtures/benchmark-file.js";
import { CharStream } from "../char-stream.js";
import { parseChars } from "../parse-chars.js";

bench("parser performance (excluding syntax-macros)", () => {
  const chars = new CharStream(BENCH_FILE, "raw");
  parseChars(chars);
});

bench("full parser performance", () => {
  parse(BENCH_FILE);
});
