import inspector from "node:inspector";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { parse } from "../parser/parser.js";
import { BENCH_FILE } from "../parser/__tests__/fixtures/benchmark-file.js";

/**
 * Profile/benchmark the parser.
 *
 * Usage examples:
 *  1) Compile then run JS with the inspector:
 *     node --inspect ./dist/parser/__tests__/profile.js --pause --n 500 --w 50 --keep 15
 *
 *  2) Run TS directly (if using tsx):
 *     node --inspect --loader tsx ./src/parser/__tests__/profile.ts --pause --n 500
 *
 *  Optional flags:
 *   --n, --iterations <num>   number of timed iterations (default: 200)
 *   --w, --warmup <num>       warmup iterations not timed (default: 20)
 *   --auto-profile            start/stop a CPU profile automatically and write <label>.cpuprofile
 *   --label <name>            filename prefix for the cpu profile (default: "parser-profile")
 *   --pause                   wait for Enter before starting (attach DevTools first)
 *   --break                   trigger a `debugger;` statement at start if a debugger is attached
 *   --keep, --keep-alive <s>  keep the process alive for <s> seconds after running (default: 0)
 *
 * Tips:
 *  • Launch with `--inspect` (or `--inspect-brk` to break on the first line).
 *  • In Chrome, open chrome://inspect to attach, then start a CPU profile or use --auto-profile.
 *  • For slightly cleaner timings, run with `--expose-gc` so we can hint GC between phases.
 */

type Options = {
  iterations: number;
  warmup: number;
  autoProfile: boolean;
  label: string;
  pause: boolean;
  keepAlive: number;
  breakOnStart: boolean;
};

function getArg(...names: string[]): string | undefined {
  for (const name of names) {
    const i = process.argv.indexOf(name);
    if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return undefined;
}

function hasFlag(...names: string[]): boolean {
  return names.some((n) => process.argv.includes(n));
}

function parseOptions(): Options {
  const iterations = parseInt(getArg("--n", "--iterations") ?? "200", 10);
  const warmup = parseInt(getArg("--w", "--warmup") ?? "20", 10);
  const autoProfile = hasFlag("--auto-profile");
  const label = getArg("--label") ?? "parser-profile";
  const pause = hasFlag("--pause");
  const keepAlive = parseInt(getArg("--keep", "--keep-alive") ?? "0", 10);
  const breakOnStart = hasFlag("--break");
  return {
    iterations,
    warmup,
    autoProfile,
    label,
    pause,
    keepAlive,
    breakOnStart,
  };
}

function maybeGC() {
  // If run with `node --expose-gc`, we can try to reduce noise between phases
  try {
    if (typeof globalThis.gc === "function") globalThis.gc();
  } catch {}
}

function runOnce(): void {
  parse(BENCH_FILE);
}

function runBenchmark(iterations: number, warmup: number): number[] {
  // Warmup (not timed)
  for (let i = 0; i < warmup; i++) runOnce();

  maybeGC();

  const times: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    runOnce();
    const t1 = performance.now();
    times[i] = t1 - t0;
  }
  return times;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function stats(times: number[]) {
  const n = times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const min = sorted[0];
  const max = sorted[n - 1];
  const variance = times.reduce((a, t) => a + (t - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { mean, median, p95, min, max, std };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000; // ms to 3 decimals
}

async function withCpuProfile<T>(
  label: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const session = new inspector.Session();
  session.connect();

  await new Promise<void>((res, rej) =>
    session.post("Profiler.enable", (err) => (err ? rej(err) : res()))
  );
  await new Promise<void>((res, rej) =>
    session.post("Profiler.start", (err) => (err ? rej(err) : res()))
  );

  const result = await fn();

  const profile: any = await new Promise((res, rej) =>
    session.post("Profiler.stop", (err, data) =>
      err ? rej(err) : res((data as any).profile)
    )
  );

  const out = `${label}.cpuprofile`;
  fs.writeFileSync(out, JSON.stringify(profile));
  console.log(`\nCPU profile written to ${out}`);
  session.disconnect();
  return result;
}

async function main() {
  const opts = parseOptions();

  if (opts.breakOnStart) {
    // Only breaks if a debugger is attached
    debugger;
  }

  if (opts.pause) {
    console.log(
      "Attach your debugger (e.g., chrome://inspect), then press Enter to start..."
    );
    await new Promise<void>((res) => {
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", () => {
        console.log("Starting");
        return res();
      });
    });
  }

  const runAndReport = async () => {
    const times = runBenchmark(opts.iterations, opts.warmup);
    const s = stats(times);

    console.log("\nParser benchmark (ms)");
    console.table({
      iterations: opts.iterations,
      warmup: opts.warmup,
      mean: round(s.mean),
      median: round(s.median),
      p95: round(s.p95),
      min: round(s.min),
      max: round(s.max),
      std: round(s.std),
    });
  };

  if (opts.autoProfile) {
    await withCpuProfile(opts.label, runAndReport);
  } else {
    await runAndReport();
  }

  if (opts.keepAlive > 0) {
    console.log(
      `\nKeeping process alive for ${opts.keepAlive}s (Ctrl+C to exit)...`
    );
    await new Promise((res) => setTimeout(res, opts.keepAlive * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
