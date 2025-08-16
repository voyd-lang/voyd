import { CharStream } from "../char-stream.js";
import { parseChars } from "../parse-chars.js";
import { parse } from "../parser.js";
import { voydFile, voydFileWithGenerics } from "./fixtures/voyd-file.js";
import { test } from "vitest";

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(parse(voydFile)).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(parse(voydFileWithGenerics)).toMatchSnapshot();
});

const BIG = voydFile.repeat(30);

test("parseChars throughput budget (>= 2 MB/s)", (t) => {
  let sink = 0; // prevent dead-code elimination
  const opsPerSec = measureOpsPerSec(() => {
    const chars = new CharStream(BIG, "raw");
    return (sink ^= parseChars(chars) ? 1 : 0);
  });
  const bytesPerOp = Buffer.byteLength(BIG, "utf8");
  const mbPerSec = (opsPerSec * bytesPerOp) / 1e6;
  t.expect(mbPerSec).toBeGreaterThanOrEqual(0.4);
});

test("parser throughput budget (>= 0.5 MB/s)", (t) => {
  let sink = 0; // prevent dead-code elimination
  const opsPerSec = measureOpsPerSec(() => (sink ^= parse(BIG) ? 1 : 0));
  const bytesPerOp = Buffer.byteLength(BIG, "utf8");
  const mbPerSec = (opsPerSec * bytesPerOp) / 1e6;
  t.expect(mbPerSec).toBeGreaterThanOrEqual(0.2);
});

function measureOpsPerSec(fn: () => void, warmupMs = 50, runMs = 200) {
  const until = (t: number) => {
    while (performance.now() < t) fn();
  };
  until(performance.now() + warmupMs);
  let n = 0;
  const end = performance.now() + runMs;
  const start = performance.now();
  while (performance.now() < end) {
    fn();
    n++;
  }
  const total = performance.now() - start;
  return (n / total) * 1000;
}
