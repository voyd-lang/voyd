#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const entryPath = resolve(
  repoRoot,
  "tests/performance/fixtures/scalar-aggregate-representative.voyd",
);
const workerMode = valueAfter("--worker-mode");
const artifactPath = valueAfter("--artifact");

if (workerMode) {
  const { createSdk } = await import("@voyd-lang/sdk");
  const compileOptions = { entryPath, optimize: false };
  const compile = async (sdk) => {
    const startedAt = performance.now();
    const result = await sdk.compile(compileOptions);
    if (!result.success) {
      throw new Error(
        result.diagnostics.map(({ message }) => message).join("\n"),
      );
    }
    return {
      compileMs: performance.now() - startedAt,
      wasmBytes: result.wasm.byteLength,
    };
  };

  if (workerMode === "memory") {
    if (!artifactPath) throw new Error("memory worker requires --artifact");
    const sdk = createSdk({ compilerCache: "memory" });
    const cold = await compile(sdk);
    const artifactStartedAt = performance.now();
    const artifact = sdk.exportCompilerArtifact();
    if (!artifact) throw new Error("memory worker did not produce an artifact");
    const artifactJson = JSON.stringify(artifact);
    const artifactMs = performance.now() - artifactStartedAt;
    writeFileSync(artifactPath, artifactJson);
    const warm = await compile(sdk);
    writeMeasurement({
      mode: "memory",
      coldCompileMs: cold.compileMs,
      warmCompileMs: warm.compileMs,
      artifactMs,
      artifactBytes: Buffer.byteLength(artifactJson),
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      wasmBytes: warm.wasmBytes,
    });
  } else {
    const artifact =
      workerMode === "artifact"
        ? JSON.parse(readFileSync(requiredArtifactPath(), "utf8"))
        : undefined;
    const sdk =
      workerMode === "cold"
        ? createSdk({ compilerCache: "none" })
        : createSdk({ compilerArtifact: artifact });
    const measured = await compile(sdk);
    writeMeasurement({
      mode: workerMode,
      ...measured,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  }
} else {
  const scratch = mkdtempSync(resolve(tmpdir(), "voyd-compiler-cache-bench-"));
  const artifact = resolve(scratch, "artifact.json");
  try {
    const cold = runWorker({ mode: "cold", artifact });
    const memory = runWorker({ mode: "memory", artifact });
    const seeded = runWorker({ mode: "artifact", artifact });
    process.stdout.write(
      `${JSON.stringify({ cold, memory, artifact: seeded }, null, 2)}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runWorker({ mode, artifact }) {
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--worker-mode",
      mode,
      "--artifact",
      artifact,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `${mode} compiler benchmark failed\n${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(child.stdout.trim());
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArtifactPath() {
  if (!artifactPath) throw new Error("artifact worker requires --artifact");
  return artifactPath;
}

function writeMeasurement(measurement) {
  process.stdout.write(`${JSON.stringify(measurement)}\n`);
}
