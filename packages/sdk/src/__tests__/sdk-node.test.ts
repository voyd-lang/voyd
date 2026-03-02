import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectNodeModulesDirs,
  createSdk,
  type CompileResult,
  type EffectContinuation,
  type EffectHandler,
} from "@voyd/sdk";
import { createVoydHost } from "@voyd/sdk/js-host";

const EFFECT_SOURCE = `use std::msgpack::self as __std_msgpack
use std::string::self as __std_string

@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32

pub fn main(): Async -> i32
  Async::await(2) + 1
`;
const ASYNC_EFFECT_ID = "com.example.async";
const RUNTIME_DIAGNOSTICS_SECTION = "voyd.runtime_diagnostics";
const sdkTestRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sdkTestRoot, "../../../../");

const hasRuntimeDiagnosticsSection = (wasm: Uint8Array): boolean => {
  const buffer =
    wasm.buffer instanceof ArrayBuffer &&
    wasm.byteOffset === 0 &&
    wasm.byteLength === wasm.buffer.byteLength
      ? wasm.buffer
      : wasm.slice().buffer;
  const module = new WebAssembly.Module(buffer);
  const sections = WebAssembly.Module.customSections(
    module,
    RUNTIME_DIAGNOSTICS_SECTION
  );
  return sections.length > 0;
};

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  expect(result.success).toBe(true);
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

  it("emits runnable optimized wasm for package-based projects", async () => {
    const sdk = createSdk();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-opt-node-modules-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const packageRoot = path.join(projectRoot, "node_modules", "voyd_semver");

    await fs.mkdir(srcDir, { recursive: true });
    await fs.copyFile(
      path.join(
        repoRoot,
        "apps",
        "smoke",
        "fixtures",
        "node-modules-voyd-semver",
        "main.voyd",
      ),
      entryPath,
    );
    await fs.cp(path.join(repoRoot, "packages", "voyd_semver"), packageRoot, {
      recursive: true,
    });

    try {
      const result = expectCompileSuccess(
        await sdk.compile({ entryPath, optimize: true }),
      );
      expect(hasRuntimeDiagnosticsSection(result.wasm)).toBe(false);
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(42);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("can disable runtime diagnostics for non-optimized builds", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn main() -> i32
  42
`,
        runtimeDiagnostics: false,
      }),
    );
    expect(hasRuntimeDiagnosticsSection(result.wasm)).toBe(false);
  });

  it("emits runtime diagnostics metadata by default", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn main() -> i32
  42
`,
      }),
    );
    expect(hasRuntimeDiagnosticsSection(result.wasm)).toBe(true);
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

  it("runs std env effects with default host adapters", async () => {
    const envKey = "VOYD_SDK_DEFAULT_ADAPTER_TEST";
    const original = process.env[envKey];
    const sdk = createSdk();
    const source = `use std::host_dto::HostDto
use std::msgpack::MsgPack
use std::msgpack::self as msgpack
use std::string::type::String

@effect(id: "voyd.std.env")
eff Env
  get(tail, key: MsgPack) -> MsgPack
  set(tail, payload: MsgPack) -> MsgPack

pub fn main(): Env -> i32
  let set_payload = HostDto::init()
    .set("key", msgpack::make_string("${envKey}"))
    .set("value", msgpack::make_string("41"))
    .pack()
  let _ = Env::set(set_payload)
  let payload = Env::get(msgpack::make_string("${envKey}"))
  payload.match(active)
    String:
      if active.equals("41") then:
        41
      else:
        -2
    else:
      -3
`;

    try {
      const result = expectCompileSuccess(await sdk.compile({ source }));
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(41);
    } finally {
      if (original === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = original;
      }
    }
  });

  it("runs std fetch effects with default host adapters", async () => {
    const sdk = createSdk();
    const source = `use std::host_dto::HostDto
use std::msgpack::MsgPack
use std::msgpack::self as msgpack

@effect(id: "voyd.std.fetch")
eff Fetch
  request(tail, payload: MsgPack) -> MsgPack

pub fn main(): Fetch -> i32
  let header = HostDto::init()
    .set("name", msgpack::make_string("accept".as_slice().to_string()))
    .set("value", msgpack::make_string("text/plain".as_slice().to_string()))
    .pack()
  let request_payload = HostDto::init()
    .set("method", msgpack::make_string("POST".as_slice().to_string()))
    .set("url", msgpack::make_string("https://example.test/echo".as_slice().to_string()))
    .set("headers", msgpack::make_array([header]))
    .set("body", msgpack::make_string("ping".as_slice().to_string()))
    .set("timeout_millis", msgpack::make_i32(10))
    .pack()

  let response_payload = Fetch::request(request_payload)
  let response = HostDto::unpack(response_payload)
  if response.read_bool("ok") == false then:
    return -1

  let value = HostDto::unpack(response.read_msgpack("value"))
  if value.read_i32("status") == 201 and value.read_string("body").equals("pong") then:
    201
  else:
    -2
`;
    const result = expectCompileSuccess(await sdk.compile({ source }));
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          fetchRequest: async () => ({
            status: 201,
            statusText: "Created",
            headers: [{ name: "content-type", value: "text/plain" }],
            body: "pong",
          }),
        },
      },
    });

    const output = await host.run<number>("main");
    expect(output).toBe(201);
  });

  it("runs std input effects with default host adapters", async () => {
    const sdk = createSdk();
    const source = `use std::error::HostError
use std::input::read_line
use std::optional::types::all
use std::result::types::all
use std::string::type::String

pub fn main() -> i32
  match(read_line())
    Ok<Option<String>> { value }:
      match(value)
        Some<String> { value: line }:
          if line.equals("voyd") then:
            1
          else:
            -2
        None:
          0
    Err<HostError>:
      -1
`;
    const result = expectCompileSuccess(await sdk.compile({ source }));
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readLine: async () => "voyd",
        },
      },
    });

    const output = await host.run<number>("main");
    expect(output).toBe(1);
  });

  it("runs std input/output byte and tty effects with default host adapters", async () => {
    const sdk = createSdk();
    const source = `use std::bytes::Bytes
use std::error::IoError
use std::input::{ read_bytes, is_tty as input_is_tty }
use std::optional::types::all
use std::output::{ write, write_line, write_bytes, flush, is_tty as output_is_tty, StdErr }
use std::result::types::all

fn sum_bytes(bytes: Bytes): () -> i32
  let values = bytes.to_array()
  var index = 0
  var total = 0
  while index < values.len() do:
    match(values.get(index))
      Some<i32> { value }:
        total = total + value
      None:
        void
    index = index + 1
  total

pub fn main() -> i32
  if input_is_tty() == false then:
    return -10
  if output_is_tty() == false then:
    return -11
  if output_is_tty(StdErr {}) then:
    return -12

  let read_result = match(read_bytes(4))
    Ok<Option<Bytes>> { value }:
      match(value)
        Some<Bytes> { value: bytes }:
          sum_bytes(bytes)
        None:
          return -2
    Err<IoError>:
      return -1

  let ~buffer = std::bytes::ByteBuffer::with_capacity(2)
  buffer.push(7)
  buffer.push(8)
  let _ = write("hello".as_slice())
  let _ = write_line("ok".as_slice())
  let _ = write_bytes(buffer.as_bytes(), StdErr {})
  let _ = flush()
  let _ = flush(StdErr {})

  read_result
`;
    const result = expectCompileSuccess(await sdk.compile({ source }));
    const writes: Array<{ target: string; value: string }> = [];
    const byteWrites: Array<{ target: string; bytes: number[] }> = [];
    const flushes: string[] = [];
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          readBytes: async () => Uint8Array.from([7, 8, 9]),
          isInputTty: () => true,
          write: async ({ target, value }) => {
            writes.push({ target, value });
          },
          writeBytes: async ({ target, bytes }) => {
            byteWrites.push({ target, bytes: Array.from(bytes.values()) });
          },
          flush: async ({ target }) => {
            flushes.push(target);
          },
          isOutputTty: (target) => target === "stdout",
        },
      },
    });

    const output = await host.run<number>("main");
    expect(output).toBe(24);
    expect(writes).toEqual([
      { target: "stdout", value: "hello" },
      { target: "stdout", value: "ok\n" },
    ]);
    expect(byteWrites).toEqual([{ target: "stderr", bytes: [7, 8] }]);
    expect(flushes).toEqual(["stdout", "stderr"]);
  });

  it("isolates concurrent managed runs so effect payloads do not race", async () => {
    const sdk = createSdk();
    const source = `use std::msgpack::self as __std_msgpack

@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32

pub fn main() -> i32
  0

pub fn first(): Async -> i32
  Async::await(11)

pub fn second(): Async -> i32
  Async::await(22)
`;
    const result = expectCompileSuccess(await sdk.compile({ source }));
    const op = result.effects.findUniqueOpByLabelSuffix("Async::await");
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: false,
    });
    host.registerHandler(op.effectId, op.opId, op.signatureHash, async ({ resume }, value) => {
      await Promise.resolve();
      return resume(value);
    });
    host.initEffects();

    const left = host.runManaged<number>("first");
    const right = host.runManaged<number>("second");

    await expect(left.outcome).resolves.toEqual({ kind: "value", value: 11 });
    await expect(right.outcome).resolves.toEqual({ kind: "value", value: 22 });
  });
});
