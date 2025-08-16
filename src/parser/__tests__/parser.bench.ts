import { bench } from "vitest";
import { parse } from "../parser.js";
import { simplerVoydFile } from "./fixtures/voyd-file.js";
import { FAST_MACROS } from "../reader-macros/index.js";

const BIG = simplerVoydFile.repeat(500);

bench(
  "parser performance",
  () => {
    parse(BIG, undefined, FAST_MACROS);
  },
  {
    time: 2000, // measure ~2s
    warmupTime: 500, // warm JIT
    iterations: 20,
    warmupIterations: 5,
  }
);
