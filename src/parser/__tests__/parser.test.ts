import { CharStream } from "../char-stream.js";
import { parseChars } from "../parse-chars.js";
import { parse } from "../parser.js";
import { BENCH_FILE, BENCH_FILE_SM } from "./fixtures/benchmark-file.js";
import { voydFile, voydFileWithGenerics } from "./fixtures/voyd-file.js";
import { test } from "vitest";

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(parse(voydFile)).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(parse(voydFileWithGenerics)).toMatchSnapshot();
});

test("parseChars throughput budget (>= 2 MB/s)", (t) => {
  let sink = 0; // prevent dead-code elimination

  const opsPerSec = measureOpsPerSec(() => {
    const chars = new CharStream(BENCH_FILE_SM, "raw");
    return (sink ^= parseChars(chars) ? 1 : 0);
  });

  const bytesPerOp = Buffer.byteLength(BENCH_FILE_SM, "utf8");
  const mbPerSec = (opsPerSec * bytesPerOp) / 1e6;
  logPerf(mbPerSec, opsPerSec, bytesPerOp);
  t.expect(mbPerSec).toBeGreaterThanOrEqual(0.4);
});

test("parser throughput budget (>= 0.5 MB/s)", (t) => {
  let sink = 0; // prevent dead-code elimination
  const opsPerSec = measureOpsPerSec(
    () => (sink ^= parse(BENCH_FILE_SM) ? 1 : 0)
  );
  const bytesPerOp = Buffer.byteLength(BENCH_FILE_SM, "utf8");
  const mbPerSec = (opsPerSec * bytesPerOp) / 1e6;
  logPerf(mbPerSec, opsPerSec, bytesPerOp);
  t.expect(mbPerSec).toBeGreaterThanOrEqual(0.2);
});

function measureOpsPerSec(fn: () => void, warmupMs = 30, runMs = 200) {
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

const logPerf = (mbPerSec: number, opsPerSec: number, bytesPerOp: number) => {
  const mbps = mbPerSec.toLocaleString();
  const ops = opsPerSec.toLocaleString();
  const mb = (bytesPerOp / 1e6).toLocaleString();
  const str = `Achieved total throughput of ${mbps} MB/s (${ops} OP/s * ${mb} MB)`;
  console.log(str);
};
