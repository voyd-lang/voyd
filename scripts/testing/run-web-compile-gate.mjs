#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const worker = process.argv.includes("--worker");
const maxOldSpaceMb = Number(
  process.env.VOYD_WEB_COMPILE_MAX_OLD_SPACE_MB ?? 3584,
);
const maxCompileMs = Number(process.env.VOYD_WEB_COMPILE_MAX_MS ?? 120_000);
const maxRssBytes = Number(
  process.env.VOYD_WEB_COMPILE_MAX_RSS_BYTES ?? 4.25 * 1024 * 1024 * 1024,
);

if (worker) {
  const { createSdk } = await import("@voyd-lang/sdk");
  const startedAt = performance.now();
  const result = await createSdk({ compilerCache: "none" }).compile({
    entryPath: resolve(
      repoRoot,
      "tests/integration/fixtures/web-framework.voyd",
    ),
    roots: { pkgDirs: [resolve(repoRoot, "packages")] },
    optimize: false,
    boundaryExports: true,
  });
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      compileMs: performance.now() - startedAt,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      wasmBytes: result.wasm.byteLength,
    })}\n`,
  );
} else {
  if (![maxOldSpaceMb, maxCompileMs, maxRssBytes].every(Number.isFinite)) {
    throw new Error("web compile gate budgets must be finite numbers");
  }
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceMb}`,
      "--conditions=development",
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--worker",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: maxCompileMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, VOYD_COMPILER_PERF: "0" },
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `whole web package compile failed (exit ${child.status ?? "unknown"})\n${child.stderr || child.stdout}`,
    );
  }
  const measurement = JSON.parse(child.stdout.trim());
  if (measurement.compileMs > maxCompileMs) {
    throw new Error(
      `whole web package compile ${measurement.compileMs.toFixed(0)}ms exceeds ${maxCompileMs}ms`,
    );
  }
  if (measurement.maxRssBytes > maxRssBytes) {
    throw new Error(
      `whole web package peak RSS ${measurement.maxRssBytes} exceeds ${maxRssBytes}`,
    );
  }
  process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
}
