import { parse } from "../parser.js";
import { simplerVoydFile } from "./fixtures/voyd-file.js";

const BIG = simplerVoydFile.repeat(1450);

let sink = 0; // prevent dead-code elimination
const opsPerSec = measureOpsPerSec(() => (sink ^= parse(BIG) ? 1 : 0));
console.log("Ops per second");
console.log(opsPerSec);
const bytesPerOp = Buffer.byteLength(BIG, "utf8");
console.log("MB");
console.log(bytesPerOp / 1e6);
const mbPerSec = (opsPerSec * bytesPerOp) / 1e6;
console.log("MB/s");
console.log(mbPerSec);

function measureOpsPerSec(fn: () => void, warmupMs = 5000, runMs = 5000) {
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
