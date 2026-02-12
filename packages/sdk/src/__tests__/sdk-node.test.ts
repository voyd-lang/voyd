import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectNodeModulesDirs,
  createSdk,
  type CompileResult,
  type EffectContinuation,
  type EffectHandler,
} from "@voyd/sdk";

const EFFECT_SOURCE = `use std::msgpack::self as __std_msgpack
use std::string::self as __std_string

@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32

pub fn main(): Async -> i32
  Async::await(2) + 1
`;
const ASYNC_EFFECT_ID = "com.example.async";

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result;
};

const buildFallbackHandlers = ({
  result,
  exclude = [],
}: {
  result: Extract<CompileResult, { success: true }>;
  exclude?: Array<{ effectId: string; opName: string; signatureHash: string }>;
}): Record<string, EffectHandler> =>
  Object.fromEntries(
    result.effects.table.ops
      .filter(
        (op) =>
          !exclude.some(
            (entry) =>
              entry.effectId === op.effectId &&
              entry.opName === op.opName &&
              entry.signatureHash === op.signatureHash,
          ),
      )
      .map((op) => [
        result.effects.handlerKeyFor({
          effectId: op.effectId,
          opName: op.opName,
          signatureHash: op.signatureHash,
        }),
        ({ resume, tail }: EffectContinuation) =>
          op.resumeKind === "tail" ? tail() : resume(),
      ]),
  ) as Record<string, EffectHandler>;

describe("node sdk", () => {
  it("returns diagnostics on compile failure instead of throwing", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({
      source: `pub fn main() -> i32
  missing_value
`,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected compile failure");
    }

    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "TY0030"),
    ).toBe(true);
  });

  it("compiles and runs a source module", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn main() -> i32
  42
`,
      }),
    );

    const output = await result.run<number>({ entryName: "main" });
    expect(output).toBe(42);
  });

  it("compiles when entryPath is relative with subdirectories", async () => {
    const sdk = createSdk();
    const repoRoot = process.cwd();
    const tempRoot = await fs.mkdtemp(path.join(repoRoot, ".tmp-voyd-sdk-"));
    const srcDir = path.join(tempRoot, "src");
    const entryPath = path.join(srcDir, "index.voyd");
    const relativeEntryPath = path.relative(repoRoot, entryPath);
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      entryPath,
      `pub fn main() -> i32
  7
`,
    );

    try {
      const result = expectCompileSuccess(
        await sdk.compile({ entryPath: relativeEntryPath }),
      );
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(7);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("collects node_modules directories from source up to filesystem root", () => {
    const startDir = path.join(path.sep, "tmp", "voyd", "nested");
    const resolvedStart = path.resolve(startDir);
    const rootDir = path.parse(resolvedStart).root;
    const parentDir = path.dirname(resolvedStart);

    const dirs = collectNodeModulesDirs(startDir);

    expect(dirs[0]).toBe(path.join(resolvedStart, "node_modules"));
    expect(dirs.at(-1)).toBe(path.join(rootDir, "node_modules"));
    expect(dirs).toContain(path.join(parentDir, "node_modules"));
  });

  it("resolves packages from the default node_modules search path", async () => {
    const sdk = createSdk();
    const repoRoot = process.cwd();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-node-modules-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const packageSrcDir = path.join(
      projectRoot,
      "node_modules",
      "my_pkg",
      "src",
    );

    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(packageSrcDir, { recursive: true });
    await fs.writeFile(
      entryPath,
      `use pkg::my_pkg::all

pub fn main() -> i32
  plus_one(41)
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "pkg.voyd"),
      `pub use src::math::plus_one
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "math.voyd"),
      `pub fn plus_one(value: i32) -> i32
  value + 1
`,
    );

    try {
      const result = expectCompileSuccess(await sdk.compile({ entryPath }));
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(42);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves packages from additional configured pkgDirs", async () => {
    const sdk = createSdk();
    const repoRoot = process.cwd();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-pkg-dirs-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const packageRoot = path.join(projectRoot, "vendor_packages");
    const packageSrcDir = path.join(packageRoot, "vendor_lib", "src");

    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(packageSrcDir, { recursive: true });
    await fs.writeFile(
      entryPath,
      `use pkg::vendor_lib::all

pub fn main() -> i32
  ten()
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "pkg.voyd"),
      `pub use src::api::ten
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "api.voyd"),
      `pub fn ten() -> i32
  10
`,
    );

    try {
      const result = expectCompileSuccess(
        await sdk.compile({
          entryPath,
          roots: { pkgDirs: [packageRoot], src: srcDir },
        }),
      );
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(10);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("supports handlersByLabelSuffix using :: separators", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ source: EFFECT_SOURCE }),
    );
    const op = result.effects.findUniqueOpByLabelSuffix("Async::await");
    const output = await result.run<number>({
      entryName: "main",
      handlers: buildFallbackHandlers({
        result,
        exclude: [
          {
            effectId: op.effectId,
            opName: op.opName,
            signatureHash: op.signatureHash,
          },
        ],
      }),
      handlersByLabelSuffix: {
        "Async::await": ({ resume }, value: unknown) =>
          resume((value as number) + 40),
      },
    });
    expect(output).toBe(43);
  });

  it("supports effectId::opName keys without signatureHash for non-overloaded ops", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ source: EFFECT_SOURCE }),
    );
    const op = result.effects.findUniqueOpByLabelSuffix("Async::await");
    expect(op.effectId).toBe(ASYNC_EFFECT_ID);
    const handlers: Record<string, EffectHandler> = {
      ...buildFallbackHandlers({ result }),
      [`${ASYNC_EFFECT_ID}::${op.opName}`]: ({ resume }, value: unknown) =>
        resume((value as number) + 40),
    };
    const output = await result.run<number>({
      entryName: "main",
      handlers,
    });
    expect(output).toBe(43);
  });

  it("exposes signatureHashFor and handlerKeyFor helpers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ source: EFFECT_SOURCE }),
    );
    const op = result.effects.findUniqueOpByLabelSuffix("Async::await");
    expect(op.effectId).toBe(ASYNC_EFFECT_ID);
    const signatureHash = result.effects.signatureHashFor({
      effectId: ASYNC_EFFECT_ID,
      opName: op.opName,
    });
    const key = result.effects.handlerKeyFor({
      effectId: ASYNC_EFFECT_ID,
      opName: op.opName,
      signatureHash,
    });
    const handlers: Record<string, EffectHandler> = {
      ...buildFallbackHandlers({ result }),
      [key]: ({ resume }, value: unknown) => resume((value as number) + 40),
    };

    const output = await result.run<number>({
      entryName: "main",
      handlers,
    });
    expect(output).toBe(43);
  });
});
