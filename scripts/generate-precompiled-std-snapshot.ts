import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeModules,
  loadModuleGraph,
} from "@voyd-lang/compiler/pipeline.js";
import {
  PRECOMPILED_STD_COMPILER_ABI_ID,
  PRECOMPILED_STD_OPTIONS_ID,
  PRECOMPILED_STD_SNAPSHOT_SCHEMA,
  PRECOMPILED_STD_SNAPSHOT_VERSION,
  PRECOMPILED_STD_TRANSPORT_ID,
  encodePrecompiledStdSnapshot,
} from "@voyd-lang/compiler/modules/precompiled-std-snapshot.js";
import {
  CALLABLE_BORROW_SUMMARY_SCHEMA,
  CALLABLE_BORROW_SUMMARY_VERSION,
} from "@voyd-lang/compiler/semantics/borrowing/callable-summary.js";
import {
  PRECOMPILED_STD_SNAPSHOT_FILE,
  collectStdSourcePaths,
  createStdSourceManifest,
  parsePrecompiledStdArtifact,
  serializePrecompiledStdArtifact,
} from "../packages/sdk/src/precompiled-std.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stdPackageRoot = path.join(repoRoot, "packages/std");
const stdRoot = path.join(stdPackageRoot, "src");
const artifactPath = path.join(stdPackageRoot, PRECOMPILED_STD_SNAPSHOT_FILE);
const check = process.argv.includes("--check");

const graph = await loadModuleGraph({
  entryPath: path.join(stdRoot, "prelude.voyd"),
  roots: {
    src: path.join(repoRoot, "tests/performance/fixtures"),
    std: stdRoot,
  },
  includeTests: false,
});
if (graph.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
  throw new Error(
    `cannot generate precompiled std graph:\n${graph.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n")}`,
  );
}
const analyzed = analyzeModules({
  graph,
  includeTests: false,
  captureDependencySnapshot: true,
});
if (
  analyzed.diagnostics.some((diagnostic) => diagnostic.severity === "error")
) {
  throw new Error(
    `cannot generate precompiled std semantics:\n${analyzed.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n")}`,
  );
}
const dependencySnapshot = analyzed.dependencySnapshot;
if (!dependencySnapshot) {
  throw new Error(
    "std analysis did not produce a reusable dependency snapshot",
  );
}

const sourceManifest = await createStdSourceManifest({
  stdRoot,
  relativePaths: await collectStdSourcePaths(stdRoot),
});
const payload = encodePrecompiledStdSnapshot({
  graphModules: graph.modules,
  dependencySnapshot,
  stdRoot,
});
const serialized = serializePrecompiledStdArtifact({
  header: {
    schema: PRECOMPILED_STD_SNAPSHOT_SCHEMA,
    version: PRECOMPILED_STD_SNAPSHOT_VERSION,
    compilerAbiId: PRECOMPILED_STD_COMPILER_ABI_ID,
    transportId: PRECOMPILED_STD_TRANSPORT_ID,
    callableSummarySchema: CALLABLE_BORROW_SUMMARY_SCHEMA,
    callableSummaryVersion: CALLABLE_BORROW_SUMMARY_VERSION,
    stdContentSha256: sourceManifest.stdContentSha256,
    optionsId: PRECOMPILED_STD_OPTIONS_ID,
    sources: sourceManifest.sources,
  },
  payload,
});

if (check) {
  const existing = await readFile(artifactPath).catch(() => undefined);
  const existingArtifact = existing
    ? parsePrecompiledStdArtifact(existing, { verifyCanonicalPayload: true })
    : undefined;
  const generatedArtifact = parsePrecompiledStdArtifact(serialized, {
    verifyCanonicalPayload: true,
  });
  if (
    !existingArtifact ||
    JSON.stringify(existingArtifact.envelope.header) !==
      JSON.stringify(generatedArtifact.envelope.header) ||
    existingArtifact.envelope.payloadSha256 !==
      generatedArtifact.envelope.payloadSha256
  ) {
    throw new Error(
      `precompiled std snapshot is stale; run npm run generate:std-snapshot`,
    );
  }
} else {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, serialized);
}

process.stdout.write(
  `${check ? "verified" : "generated"} ${path.relative(
    repoRoot,
    artifactPath,
  )} (${serialized.byteLength} bytes, ${
    dependencySnapshot.moduleIds.length
  } modules)\n`,
);
