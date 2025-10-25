import { bench } from "vitest";
import { parse } from "../parser.js";
import { BENCH_FILE } from "./fixtures/benchmark-file.js";
import { CharStream } from "../char-stream.js";
import { read } from "../reader.js";

bench("parser performance (excluding syntax-macros)", () => {
  const chars = new CharStream(BENCH_FILE, "raw");
  read(chars);
});

bench("full parser performance", () => {
  parse(BENCH_FILE);
});
