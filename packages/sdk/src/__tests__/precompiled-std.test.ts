import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRECOMPILED_STD_COMPILER_ABI_ID,
  PRECOMPILED_STD_OPTIONS_ID,
  PRECOMPILED_STD_SNAPSHOT_SCHEMA,
  PRECOMPILED_STD_SNAPSHOT_VERSION,
  PRECOMPILED_STD_TRANSPORT_ID,
  type PrecompiledStdSnapshotEnvelope,
} from "@voyd-lang/compiler/modules/precompiled-std-snapshot.js";
import {
  CALLABLE_BORROW_SUMMARY_SCHEMA,
  CALLABLE_BORROW_SUMMARY_VERSION,
} from "@voyd-lang/compiler/semantics/borrowing/callable-summary.js";
import {
  PRECOMPILED_STD_SNAPSHOT_FILE,
  loadPrecompiledStdSnapshot,
  precompiledStdArtifactsHaveMatchingCanonicalContent,
  resetPrecompiledStdLoadStatsForTesting,
  serializePrecompiledStdArtifact,
  snapshotPrecompiledStdLoadStats,
  validatePrecompiledStdSnapshotHeader,
} from "../precompiled-std.js";
import { createSdk } from "../node.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const stdRoot = path.join(repoRoot, "packages/std/src");
const temporaryRoots: string[] = [];

afterEach(async () => {
  resetPrecompiledStdLoadStatsForTesting();
  delete process.env.VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("precompiled std semantic snapshots", () => {
  it("validates every compatibility key independently", () => {
    const valid = validEnvelope();
    expect(() => validatePrecompiledStdSnapshotHeader(valid)).not.toThrow();

    [
      ["schema", { schema: "other" }],
      ["schema version", { version: 2 }],
      [
        "compiler snapshot ABI skew",
        { compilerAbiId: `${PRECOMPILED_STD_COMPILER_ABI_ID}-other` },
      ],
      ["transport", { transportId: "other" }],
      ["summary schema", { callableSummarySchema: "other" }],
      ["summary version", { callableSummaryVersion: 999 }],
      ["options", { optionsId: "includeTests=true" }],
    ].forEach(([label, patch]) => {
      const envelope = {
        ...valid,
        header: { ...valid.header, ...(patch as object) },
      } as PrecompiledStdSnapshotEnvelope;
      expect(
        () => validatePrecompiledStdSnapshotHeader(envelope),
        String(label),
      ).toThrow();
    });
  });

  it("serializes deterministically and rejects corrupt artifacts safely", async () => {
    const cyclic = new Map<string, unknown>();
    cyclic.set("self", cyclic);
    const first = serializePrecompiledStdArtifact({
      header: validEnvelope().header,
      payload: cyclic,
    });
    const second = serializePrecompiledStdArtifact({
      header: validEnvelope().header,
      payload: cyclic,
    });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);

    const root = await createTemporaryStdRoot({ copyStd: true });
    const artifactPath = path.resolve(
      root,
      "..",
      PRECOMPILED_STD_SNAPSHOT_FILE,
    );
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, Buffer.from(first).subarray(0, 12));

    const result = await createSdk().compile({
      source: "pub fn main() -> i32 = 42",
      roots: { src: path.resolve(root, "..", "app"), std: root },
    });
    expect(result.success).toBe(true);
    expect(snapshotPrecompiledStdLoadStats().fallbacks).toBe(1);

    resetPrecompiledStdLoadStatsForTesting();
    const bundled = await fs.readFile(
      path.join(repoRoot, "packages/std", PRECOMPILED_STD_SNAPSHOT_FILE),
    );
    const headerLength = bundled.readUInt32BE(8);
    const fastPayloadStart = 12 + headerLength + 4;
    bundled[fastPayloadStart] ^= 0xff;
    await fs.writeFile(artifactPath, bundled);
    const canonicalFallbackResult = await createSdk().compile({
      source: "pub fn main() -> i32 = 42",
      roots: { src: path.resolve(root, "..", "app"), std: root },
    });
    expect(canonicalFallbackResult.success).toBe(true);
    expect(snapshotPrecompiledStdLoadStats()).toMatchObject({
      hits: 1,
      fallbacks: 0,
    });

    resetPrecompiledStdLoadStatsForTesting();
    bundled[bundled.byteLength - 1] ^= 0xff;
    await fs.writeFile(artifactPath, bundled);
    const fullyCorruptedResult = await createSdk().compile({
      source: "pub fn main() -> i32 = 42",
      roots: { src: path.resolve(root, "..", "app"), std: root },
    });
    expect(fullyCorruptedResult.success).toBe(true);
    expect(snapshotPrecompiledStdLoadStats().fallbacks).toBe(1);
  });

  it("checks freshness independently from the optional V8 accelerator", () => {
    const canonical = validEnvelope();
    const otherEngine = {
      envelope: {
        ...canonical,
        fastPayloadSha256: "another-engine-payload",
        fastPayloadProducer: {
          node: "22.23.1",
          v8: "12.4.254.21-node.33",
        },
      },
    };

    expect(
      precompiledStdArtifactsHaveMatchingCanonicalContent(
        { envelope: canonical },
        otherEngine,
      ),
    ).toBe(true);
    expect(
      precompiledStdArtifactsHaveMatchingCanonicalContent(
        { envelope: canonical },
        {
          envelope: {
            ...canonical,
            payloadSha256: "changed-canonical-payload",
          },
        },
      ),
    ).toBe(false);
  });

  it("invalidates the bundled artifact when std source content changes", async () => {
    const root = await createTemporaryStdRoot({ copyStd: true });
    const artifactPath = path.resolve(
      root,
      "..",
      PRECOMPILED_STD_SNAPSHOT_FILE,
    );
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.copyFile(
      path.join(repoRoot, "packages/std", PRECOMPILED_STD_SNAPSHOT_FILE),
      artifactPath,
    );
    await fs.appendFile(path.join(root, "array.voyd"), "\n// changed\n");

    await expect(
      loadPrecompiledStdSnapshot({ stdRoot: root }),
    ).resolves.toBeUndefined();
    expect(
      snapshotPrecompiledStdLoadStats().fallbackReasons["std-content"],
    ).toBe(1);
  });

  it("restores an isolated semantic identity domain for every compile", async () => {
    const first = await loadPrecompiledStdSnapshot({ stdRoot });
    const second = await loadPrecompiledStdSnapshot({ stdRoot });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(second?.modules.get("std::prelude")).not.toBe(
      first?.modules.get("std::prelude"),
    );
    expect(second?.dependencySnapshot.semantics.get("std::array")).not.toBe(
      first?.dependencySnapshot.semantics.get("std::array"),
    );
  });

  it("loads and restores the bundled artifact in a fresh process", async () => {
    const script = `
      import { createSdk, snapshotPrecompiledStdLoadStats } from "./packages/sdk/src/node.ts";
      const result = await createSdk().compile({
        source: "pub fn main() -> i32 = 42",
        entryPath: "snapshot-fresh-process.voyd"
      });
      process.stdout.write(JSON.stringify({
        success: result.success,
        stats: snapshotPrecompiledStdLoadStats()
      }));
    `;
    const child = await spawnAndCapture({
      command: process.execPath,
      args: ["--conditions=development", "--import", "tsx", "--eval", script],
      env: { ...process.env, VOYD_COMPILER_PERF: "1" },
    });
    expect(child.code).toBe(0);
    const result = JSON.parse(child.stdout) as {
      success: boolean;
      stats: { hits: number; fallbacks: number };
    };
    expect(result).toMatchObject({
      success: true,
      stats: { hits: 1, fallbacks: 0 },
    });
    expect(child.stderr).toContain('"compiler.precompiled_std_snapshot.hit":1');
    expect(child.stderr).not.toContain("graph.load_module.std");
  });

  it("analyzes explicit std modules outside the prelude snapshot from source", async () => {
    const result = await createSdk().compile({
      source: `use std::version::std_version

pub fn main() -> i32
  std_version().byte_len()
`,
    });

    expect(result.success).toBe(true);
    expect(snapshotPrecompiledStdLoadStats()).toMatchObject({
      hits: 1,
      fallbacks: 0,
    });
  });

  it("matches source analysis for codegen and borrow diagnostics", async () => {
    const validSource = `use std::output::Output

obj Item { value: i32 }

pub fn main(): Output -> i32
  let ~values = Array<Item>::with_capacity(1)
  values.push(Item { value: 7 })
  let ~view: ViewIterator<Item> = values.view_iter()
  let observed = match(view.next())
    Some<borrow Item> { value }: value.value
    None: 0
  var range_sum = 0
  for value in 0..3:
    range_sum = range_sum + value
  print("snapshot")
  observed + range_sum
`;
    const invalidSource = `obj Item { value: i32 }

pub fn main() -> i32
  let ~values = Array<Item>::with_capacity(1)
  values.push(Item { value: 7 })
  let ~view: ViewIterator<Item> = values.view_iter()
  match(view.next())
    Some<borrow Item> { value }:
      let _ = values.replace(0, with: Item { value: 8 })
      value.value
    None:
      0
`;
    const snapshotValid = await createSdk().compile({ source: validSource });
    const snapshotInvalid = await createSdk().compile({
      source: invalidSource,
    });
    process.env.VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT = "1";
    const sourceValid = await createSdk().compile({ source: validSource });
    const sourceInvalid = await createSdk().compile({ source: invalidSource });

    expect(snapshotValid.success).toBe(true);
    expect(sourceValid.success).toBe(true);
    if (snapshotValid.success && sourceValid.success) {
      expect(Buffer.from(snapshotValid.wasm)).toEqual(
        Buffer.from(sourceValid.wasm),
      );
    }
    expect(snapshotInvalid.success).toBe(false);
    expect(sourceInvalid.success).toBe(false);
    if (!snapshotInvalid.success && !sourceInvalid.success) {
      expect(snapshotInvalid.diagnostics.map(diagnosticIdentity)).toEqual(
        sourceInvalid.diagnostics.map(diagnosticIdentity),
      );
    }
  });
});

const diagnosticIdentity = (diagnostic: {
  code: string;
  message: string;
  span: { file: string; start: number; end: number };
}) => ({
  code: diagnostic.code,
  message: diagnostic.message,
  span: diagnostic.span,
});

const validEnvelope = (): PrecompiledStdSnapshotEnvelope => ({
  header: {
    schema: PRECOMPILED_STD_SNAPSHOT_SCHEMA,
    version: PRECOMPILED_STD_SNAPSHOT_VERSION,
    compilerAbiId: PRECOMPILED_STD_COMPILER_ABI_ID,
    transportId: PRECOMPILED_STD_TRANSPORT_ID,
    callableSummarySchema: CALLABLE_BORROW_SUMMARY_SCHEMA,
    callableSummaryVersion: CALLABLE_BORROW_SUMMARY_VERSION,
    stdContentSha256: "hash",
    optionsId: PRECOMPILED_STD_OPTIONS_ID,
    sources: [{ path: "pkg.voyd", sha256: "hash", bytes: 1 }],
  },
  payloadSha256: "hash",
  fastPayloadSha256: "fast-hash",
  fastPayloadProducer: {
    node: process.versions.node,
    v8: process.versions.v8,
  },
});

const createTemporaryStdRoot = async ({
  copyStd = false,
}: { copyStd?: boolean } = {}): Promise<string> => {
  const packageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "voyd-precompiled-std-"),
  );
  temporaryRoots.push(packageRoot);
  const root = path.join(packageRoot, "src");
  if (copyStd) {
    await fs.cp(stdRoot, root, { recursive: true });
  } else {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "pkg.voyd"), "");
  }
  return root;
};

const spawnAndCapture = ({
  command,
  args,
  env,
}: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
