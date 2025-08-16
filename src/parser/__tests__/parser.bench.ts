import { bench } from "vitest";
import { parse } from "../parser.js";
import { voydFile } from "./fixtures/voyd-file.js";

const BIG = voydFile.repeat(100);

bench(
  "parser performance",
  () => {
    parse(BIG);
  },
  {
    time: 2000, // measure ~2s
    warmupTime: 500, // warm JIT
    iterations: 20,
    warmupIterations: 5,
  }
);
