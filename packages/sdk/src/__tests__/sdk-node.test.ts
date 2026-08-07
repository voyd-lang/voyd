import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  collectNodeModulesDirs,
  createSdk,
  detectSrcRootForPath,
  findVoydPackageAdapterSpecifiers,
  loadVoydPackageAdapters,
  type CompileResult,
  type EffectContinuation,
  type EffectHandler,
} from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { parseExportAbi } from "@voyd-lang/js-host";
import { defineVoydPackageAdapter } from "@voyd-lang/package-adapter";

const EFFECT_SOURCE = `use std::msgpack::self as __std_msgpack
use std::string::self as __std_string

@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32

pub fn main(): Async -> i32
  Async::await(2) + 1
`;
const EXTERNAL_SOURCE = `@external(id: "example:math/ops@1")
fn double(value: i32) -> i32
  double(value)

pub fn main() -> i32
  double(21)
`;
const BOUNDARY_EXPORTS_SOURCE = `use std::array::Array
use std::enums::{ enum }
use std::optional::all
use std::string::type::String

obj Point {
  x: i32,
  y: i32
}

obj TreeNode {
  val: i32,
  l?: TreeNode,
  r?: TreeNode
}

enum LookupResult
  Found { value: String }
  Missing

enum NestedResult
  Wrapped { inner: LookupResult::Found }
  Empty {}

pub fn primitive() -> i32
  42

pub fn echo_bool(value: bool) -> bool
  value

pub fn echo_i64(value: i64) -> i64
  value

pub fn echo_f32(value: f32) -> f32
  value

pub fn translate(point: Point, dx: i32, dy: i32) -> Point
  Point {
    x: point.x + dx,
    y: point.y + dy
  }

pub fn get_point() -> { x: i32, y: i32 }
  { x: 1, y: 2 }

pub fn lookup(key: String) -> LookupResult
  if key == "name" then:
    LookupResult::Found { value: "Ada" }
  else:
    LookupResult::Missing {}

pub fn sum_values(values: Array<i32>) -> i32
  var index = 0
  var total = 0
  while index < values.len():
    total = total + values.at(index)
    index = index + 1
  total

pub fn add_float(value: f64) -> f64
  value + 1.0

pub fn nan_value() -> f64
  0.0 / 0.0

pub fn found_only() -> LookupResult::Found
  LookupResult::Found { value: "Ada" }

pub fn found_value(found: LookupResult::Found) -> String
  found.value

pub fn nested_found() -> NestedResult
  NestedResult::Wrapped {
    inner: LookupResult::Found { value: "Ada" }
  }

pub fn nested_found_value(wrapped: NestedResult::Wrapped) -> String
  wrapped.inner.value

fn optional_tree_sum(node?: TreeNode) -> i32
  match(node)
    Some<TreeNode> { value }:
      tree_sum(value)
    None:
      0

pub fn tree_sum(node: TreeNode) -> i32
  node.val + optional_tree_sum(node.l) + optional_tree_sum(node.r)

pub fn get_tree() -> TreeNode
  TreeNode {
    val: 1,
    l: TreeNode { val: 2 },
    r: TreeNode { val: 3 }
  }

pub fn cyclic_tree() -> TreeNode
  let ~node = TreeNode { val: 1 }
  node.l = Some<TreeNode> { value: node }
  node

fn make_chain(depth: i32) -> TreeNode
  if depth == 0 then:
    TreeNode { val: 0 }
  else:
    TreeNode { val: depth, l: make_chain(depth - 1) }

pub fn deep_tree() -> TreeNode
  make_chain(600)

pub fn long_text() -> String
  "this result is intentionally longer than a tiny host buffer"
`;
const ASYNC_EFFECT_ID = "com.example.async";
const RUNTIME_DIAGNOSTICS_SECTION = "voyd.runtime_diagnostics";
const sdkTestRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sdkTestRoot, "../../../../");
let effectCompileResult: Extract<CompileResult, { success: true }>;

const hasRuntimeDiagnosticsSection = (wasm: Uint8Array): boolean => {
  const module = new WebAssembly.Module(wasmBufferSource(wasm));
  const sections = WebAssembly.Module.customSections(
    module,
    RUNTIME_DIAGNOSTICS_SECTION,
  );
  return sections.length > 0;
};

const wasmBufferSource = (wasm: Uint8Array): BufferSource => {
  if (
    wasm.buffer instanceof ArrayBuffer &&
    wasm.byteOffset === 0 &&
    wasm.byteLength === wasm.buffer.byteLength
  ) {
    return wasm.buffer;
  }
  const copy = new Uint8Array(wasm.byteLength);
  copy.set(wasm);
  return copy.buffer;
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

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate tcp port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const httpGet = (
  url: string,
  timeoutMs = 2000,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out waiting for ${url}`));
    });
  });

const restoreTestEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

describe("node sdk", () => {
  const fixtureSdk = createSdk();

  it("restores web environment variables when adapter discovery fails", async () => {
    const previousPort = process.env.VOYD_WEB_PORT;
    const previousHost = process.env.VOYD_WEB_HOST;
    process.env.VOYD_WEB_PORT = "previous-port";
    process.env.VOYD_WEB_HOST = "previous-host";

    try {
      await expect(
        createSdk().serveWebApp({
          port: await findFreePort(),
          host: "127.0.0.2",
          source: EXTERNAL_SOURCE,
        }),
      ).rejects.toThrow(
        /Missing installed Voyd package adapters.*example:math\/ops@1/,
      );
      expect(process.env.VOYD_WEB_PORT).toBe("previous-port");
      expect(process.env.VOYD_WEB_HOST).toBe("previous-host");
    } finally {
      restoreTestEnv("VOYD_WEB_PORT", previousPort);
      restoreTestEnv("VOYD_WEB_HOST", previousHost);
    }
  }, 120_000);

  it("closes a long-running web app entry through the SDK helper", async () => {
    const port = await findFreePort();
    const result = await fixtureSdk.serveWebApp({
      port,
      readinessTimeoutMs: 10_000,
      source: `
use pkg::web::all
use std::env::self as env
use std::http::server::HttpServer
use std::task::self as task

pub fn main(): (HttpServer, task::TaskRuntime, env::Env) -> i32
  let port = env::get_int("VOYD_WEB_PORT".as_slice()) ?? -1
  let host = env::get("VOYD_WEB_HOST".as_slice()) ?? "127.0.0.1".as_slice().to_string()
  let _ = serve(port: port, host: host) routes():
    get("/hello") do:
      "served".as_slice().to_string()
  0
`,
    });

    if (!result.success) {
      throw new Error(
        result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      );
    }
    expect(result.success).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(port);
    expect(result.url).toBe(`http://127.0.0.1:${port}`);
    await expect(result.ready).resolves.toBeUndefined();
    await expect(httpGet(`${result.url}/hello`)).resolves.toMatchObject({
      status: 200,
      body: "served",
    });

    await expect(result.close()).resolves.toBeUndefined();
    await expect(httpGet(`${result.url}/hello`)).rejects.toThrow();
  }, 330_000);

  beforeAll(async () => {
    effectCompileResult = expectCompileSuccess(
      await fixtureSdk.compile({ source: EFFECT_SOURCE }),
    );
  });

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

  it("preserves array view loans through the public prelude API", async () => {
    const sdk = createSdk();
    const invalidSource = `obj Item { value: i32 }

fn replace_slot_during_view() -> i32
  let ~values = Array<Item>::with_capacity(1)
  values.push(Item { value: 1 })
  let ~view: ViewIterator<Item> = values.view_iter()
  match(view.next())
    Some<borrow Item> { value }:
      let _ = values.replace(0, with: Item { value: 2 })
      value.value
    None:
      0
`;
    const invalid = await sdk.compile({
      source: invalidSource,
    });
    expect(invalid.success).toBe(false);
    if (invalid.success) return;
    const conflicts = invalid.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TY0048",
    );
    expect(conflicts).toHaveLength(1);
    expect(
      invalidSource.slice(conflicts[0]!.span.start, conflicts[0]!.span.end),
    ).toContain("values.replace");

    expectCompileSuccess(
      await sdk.compile({
        source: `obj Item { value: i32 }

fn mutate(~item: Item) -> void
  item.value = item.value + 1

fn mutate_alias_during_view() -> i32
  let ~values = Array<Item>::with_capacity(1)
  values.push(Item { value: 1 })
  let ~alias = values.at(0)
  let ~view: ViewIterator<Item> = values.view_iter()
  match(view.next())
    Some<borrow Item> { value }:
      mutate(~alias)
      value.value
    None:
      0

pub fn main() -> i32
  let ~values = Array<Item>::with_capacity(1)
  values.push(Item { value: 1 })
  let ~view: ViewIterator<Item> = values.view_iter()
  let observed =
    match(view.next())
      Some<borrow Item> { value }: value.value
      None: 0
  let _ = values.replace(0, with: Item { value: 2 })
  observed
`,
      }),
    );
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

  it("does not expose mutable cached wasm across repeat compiles", async () => {
    const sdk = createSdk();
    const options = {
      source: `#!no_prelude
pub fn main() -> i32
  42
`,
    };
    const first = expectCompileSuccess(await sdk.compile(options));
    const originalFirstByte = first.wasm[0]!;
    first.wasm[0] = originalFirstByte ^ 0xff;

    const second = expectCompileSuccess(await sdk.compile(options));

    expect(second.wasm).not.toBe(first.wasm);
    expect(second.wasm[0]).toBe(originalFirstByte);
    await expect(second.run<number>({ entryName: "main" })).resolves.toBe(42);
  });

  it("invalidates SDK compile reuse when an imported source file changes", async () => {
    const sdk = createSdk();
    const source = `#!no_prelude
use src::util::value

pub fn main() -> i32
  value()
`;
    const compile = (value: number) =>
      sdk.compile({
        entryPath: "main.voyd",
        source,
        files: {
          "util.voyd": `#!no_prelude
pub fn value() -> i32
  ${value}
`,
        },
      });

    const first = expectCompileSuccess(await compile(1));
    await expect(first.run<number>({ entryName: "main" })).resolves.toBe(1);

    const second = expectCompileSuccess(await compile(2));
    await expect(second.run<number>({ entryName: "main" })).resolves.toBe(2);

    const repeatedSecond = expectCompileSuccess(await compile(2));
    await expect(
      repeatedSecond.run<number>({ entryName: "main" }),
    ).resolves.toBe(2);
  });

  it("re-emits across codegen option changes", async () => {
    const sdk = createSdk();
    const source = `#!no_prelude
pub fn main() -> i32
  1
`;

    const withoutRuntimeDiagnostics = expectCompileSuccess(
      await sdk.compile({ source, runtimeDiagnostics: false }),
    );
    const withRuntimeDiagnostics = expectCompileSuccess(
      await sdk.compile({ source, runtimeDiagnostics: true }),
    );

    expect(hasRuntimeDiagnosticsSection(withoutRuntimeDiagnostics.wasm)).toBe(
      false,
    );
    expect(hasRuntimeDiagnosticsSection(withRuntimeDiagnostics.wasm)).toBe(
      true,
    );
  });

  it("reuses dependency snapshots for app edits and invalidates std/pkg edits", async () => {
    const sdk = createSdk();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-dependency-snapshot-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const stdDir = path.join(projectRoot, "std");
    const packageRoot = path.join(projectRoot, "packages");
    const packageSrcDir = path.join(packageRoot, "dep", "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const stdPath = path.join(stdDir, "mathdep.voyd");
    const pkgApiPath = path.join(packageSrcDir, "api.voyd");

    const writeApp = (value: number) =>
      fs.writeFile(
        entryPath,
        [
          "#!no_prelude",
          "use std::mathdep::{ std_value }",
          "use pkg::dep::all",
          "",
          "pub fn main() -> i32",
          `  std_value() + pkg_value() + ${value}`,
        ].join("\n"),
      );
    const writeStd = (value: number) =>
      fs.writeFile(
        stdPath,
        ["#!no_prelude", "pub fn std_value() -> i32", `  ${value}`].join("\n"),
      );
    const writePkg = (value: number) =>
      fs.writeFile(
        pkgApiPath,
        ["#!no_prelude", "pub fn pkg_value() -> i32", `  ${value}`].join("\n"),
      );
    const compileAndRun = async () => {
      const result = expectCompileSuccess(
        await sdk.compile({
          entryPath,
          roots: { src: srcDir, std: stdDir, pkgDirs: [packageRoot] },
        }),
      );
      return result.run<number>({ entryName: "main" });
    };

    try {
      await fs.mkdir(srcDir, { recursive: true });
      await fs.mkdir(stdDir, { recursive: true });
      await fs.mkdir(packageSrcDir, { recursive: true });
      await fs.writeFile(
        path.join(packageSrcDir, "pkg.voyd"),
        ["#!no_prelude", "pub use src::api::pkg_value"].join("\n"),
      );
      await writeApp(1);
      await writeStd(10);
      await writePkg(100);

      await expect(compileAndRun()).resolves.toBe(111);

      await writeApp(2);
      await expect(compileAndRun()).resolves.toBe(112);

      await writeStd(11);
      await expect(compileAndRun()).resolves.toBe(113);

      await writePkg(101);
      await expect(compileAndRun()).resolves.toBe(114);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("supports one-shot compilation without retaining compiler cache state", async () => {
    const sdk = createSdk({ compilerCache: "none" });
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn main() -> i32
  42
`,
      }),
    );

    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(42);
    expect(sdk.exportCompilerArtifact()).toBeUndefined();
  });

  it("keeps memory reuse separate from durable borrowing artifacts", async () => {
    const sdk = createSdk({ compilerCache: "memory" });
    const source = `#!no_prelude
pub fn main() -> i32
  42
`;

    expectCompileSuccess(await sdk.compile({ source }));
    expectCompileSuccess(await sdk.compile({ source }));

    expect(sdk.exportCompilerArtifact()).toBeUndefined();
  });

  it("requires explicit artifact mode to export and import compiler artifacts", async () => {
    const entryPath = path.join(
      repoRoot,
      "tests",
      "performance",
      "fixtures",
      "vtrace-compute-benchmark.voyd",
    );
    const producer = createSdk({ compilerCache: "artifact" });
    expectCompileSuccess(await producer.compile({ entryPath }));
    const artifact = producer.exportCompilerArtifact();

    expect(artifact?.schema).toBe("voyd.compiler-dependency-borrow-cache");
    const consumer = createSdk({ compilerCache: "artifact", compilerArtifact: artifact });
    const result = expectCompileSuccess(await consumer.compile({ entryPath }));
    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(
      3_825_271,
    );
  });

  it("rejects an artifact when compiler caching is disabled", () => {
    expect(() =>
      createSdk({
        compilerCache: "none",
        compilerArtifact: {} as never,
      } as never),
    ).toThrow('compilerArtifact requires compilerCache: "artifact"');
  });

  it("rejects an unknown compiler cache policy from untyped callers", () => {
    expect(() => createSdk({ compilerCache: "disk" } as never)).toThrow(
      'unknown compiler cache policy "disk"',
    );
  });

  it("keeps dependency snapshot app edits valid for generic-heavy programs", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      repoRoot,
      "tests",
      "performance",
      "fixtures",
      "vtrace-compute-benchmark.voyd",
    );
    const source = await fs.readFile(entryPath, "utf8");

    const cold = expectCompileSuccess(await sdk.compile({ entryPath, source }));
    expect(cold.wasm.byteLength).toBeGreaterThan(0);

    const warm = expectCompileSuccess(
      await sdk.compile({
        entryPath,
        source: `${source}\nfn dependency_snapshot_app_edit_marker() -> i32\n  1\n`,
      }),
    );
    await expect(warm.run<number>({ entryName: "main" })).resolves.toBe(
      3_825_271,
    );
  });

  it("emits the same optimized wasm for fresh and dependency snapshot app edits", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      repoRoot,
      "tests",
      "integration",
      "fixtures",
      "std-math-transcendentals.voyd",
    );
    const source = await fs.readFile(entryPath, "utf8");
    const editedSource = `${source}\nfn dependency_snapshot_app_edit_marker() -> i32\n  1\n`;

    expectCompileSuccess(
      await sdk.compile({ entryPath, source, optimize: true }),
    );
    const warm = expectCompileSuccess(
      await sdk.compile({ entryPath, source: editedSource, optimize: true }),
    );
    const fresh = expectCompileSuccess(
      await createSdk().compile({
        entryPath,
        source: editedSource,
        optimize: true,
      }),
    );

    expect(warm.wasm.byteLength).toBe(fresh.wasm.byteLength);
    await expect(warm.run<number>({ entryName: "main" })).resolves.toBe(1);
    await expect(fresh.run<number>({ entryName: "main" })).resolves.toBe(1);
  });

  it("runs typed boundary exports through the existing host and sdk APIs", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ source: BOUNDARY_EXPORTS_SOURCE }),
    );
    const host = await createVoydHost({ wasm: result.wasm });
    const module = new WebAssembly.Module(wasmBufferSource(result.wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );

    await expect(host.run("primitive")).resolves.toBe(42);
    await expect(host.run("echo_bool", [true])).resolves.toBe(true);
    await expect(host.run("echo_i64", [42])).resolves.toBe(42n);
    await expect(host.run("echo_f32", [1.5])).resolves.toBe(1.5);
    await expect(host.run("echo_bool", [1])).rejects.toThrow(
      "typed export echo_bool arg0 expected bool, got number",
    );
    await expect(host.run("primitive", [1])).rejects.toThrow(
      "typed export primitive expected 0 args, got 1",
    );
    await expect(
      host.run("echo_i64", [Number.MAX_SAFE_INTEGER + 1]),
    ).rejects.toThrow("typed export echo_i64 arg0 expected i64, got number");
    expect(exports).not.toContain("__voyd_serialized_export_primitive");
    expect(abi.exports).toContainEqual({
      name: "primitive",
      abi: "direct",
      params: [],
      result: expect.objectContaining({ kind: "i32" }),
    });
    await expect(
      host.run("translate", [{ x: 1, y: 2 }, 10, 20]),
    ).resolves.toEqual({ x: 11, y: 22 });
    await expect(result.run({ entryName: "get_point" })).resolves.toEqual({
      x: 1,
      y: 2,
    });
    await expect(host.run("lookup", ["name"])).resolves.toEqual({
      tag: "Found",
      value: "Ada",
    });
    await expect(host.run("lookup", ["other"])).resolves.toEqual({
      tag: "Missing",
    });
    await expect(host.run("sum_values", [[1, 2, 3]])).resolves.toBe(6);
    await expect(
      host.run("add_float", [Number.POSITIVE_INFINITY]),
    ).resolves.toBe(Number.POSITIVE_INFINITY);
    const nanResult = await host.run<number>("nan_value");
    expect(Number.isNaN(nanResult)).toBe(true);
    await expect(host.run("found_only")).resolves.toEqual({
      tag: "Found",
      value: "Ada",
    });
    await expect(
      host.run("found_value", [{ tag: "Found", value: "Grace" }]),
    ).resolves.toBe("Grace");
    await expect(
      host.run("found_value", [{ tag: "Missing", value: "Grace" }]),
    ).rejects.toThrow(
      "typed export found_value arg0 expected variant tag Found",
    );
    await expect(host.run("nested_found")).resolves.toEqual({
      tag: "Wrapped",
      inner: { tag: "Found", value: "Ada" },
    });
    await expect(
      host.run("nested_found_value", [
        { tag: "Wrapped", inner: { tag: "Found", value: "Grace" } },
      ]),
    ).resolves.toBe("Grace");
    await expect(
      host.run("nested_found_value", [
        { tag: "Wrapped", inner: { tag: "Missing", value: "Grace" } },
      ]),
    ).rejects.toThrow(
      "typed export nested_found_value arg0.inner expected variant tag Found",
    );
    await expect(
      host.run("translate", [{ x: "bad", y: 2 }, 10, 20]),
    ).rejects.toThrow("typed export translate arg0.x expected i32, got string");
    await expect(host.run("get_tree")).resolves.toEqual({
      val: 1,
      l: { val: 2 },
      r: { val: 3 },
    });
    await expect(
      host.run("tree_sum", [{ val: 1, l: { val: 2 }, r: { val: 3 } }]),
    ).resolves.toBe(6);
    await expect(
      host.run("tree_sum", [{ val: 1, l: null, r: { val: 3 } }]),
    ).resolves.toBe(4);
    await expect(host.run("cyclic_tree")).rejects.toThrow(
      /typed export cyclic_tree result.*cannot encode cyclic object graph/,
    );
    const deepTree = await host.run<{ val: number; l?: any }>("deep_tree");
    let node = deepTree;
    let depth = 0;
    while (node.l) {
      depth += 1;
      node = node.l;
    }
    expect(depth).toBe(600);
    expect(node).toEqual({ val: 0 });
    const cyclicTree: { val: number; l?: unknown } = { val: 1 };
    cyclicTree.l = cyclicTree;
    await expect(host.run("tree_sum", [cyclicTree])).rejects.toThrow(
      "typed export tree_sum arg0.l cannot encode cyclic object graph",
    );
    const cyclicTreeMap = new Map<string, unknown>([["val", 1]]);
    cyclicTreeMap.set("l", cyclicTreeMap);
    await expect(host.run("tree_sum", [cyclicTreeMap])).rejects.toThrow(
      "typed export tree_sum arg0.l cannot encode cyclic object graph",
    );

    const tinyBufferHost = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 8,
    });
    await expect(
      tinyBufferHost.run("sum_values", [
        Array.from({ length: 32 }, (_, index) => index),
      ]),
    ).rejects.toThrow("increase createVoydHost({ bufferSize })");
    await expect(tinyBufferHost.run("long_text")).rejects.toThrow(
      "increase createVoydHost({ bufferSize })",
    );
  });

  it("keeps scalar-only typed release exports independent of serialization", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `pub fn increment(value: i32) -> i32
  value + 1
`,
        optimizationLevel: "release",
      }),
    );
    const module = new WebAssembly.Module(wasmBufferSource(result.wasm));
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );
    const abi = parseExportAbi(module);
    const host = await createVoydHost({ wasm: result.wasm });

    expect(result.wasm.byteLength).toBeLessThan(2_000);
    expect(exports).not.toContain("__voyd_serialized_export_increment");
    expect(abi.exports).toContainEqual({
      name: "increment",
      abi: "direct",
      params: [expect.objectContaining({ kind: "i32" })],
      result: expect.objectContaining({ kind: "i32" }),
    });
    await expect(host.run("increment", [41])).resolves.toBe(42);
    await expect(host.run("increment", ["41"])).rejects.toThrow(
      "typed export increment arg0 expected i32, got string",
    );
  });

  it("does not treat ordinary DTO type aliases as standalone variants", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `obj Point {
  x: i32,
  y: i32
}

type AliasPoint = Point

pub fn shift(point: AliasPoint) -> AliasPoint
  point
`,
      }),
    );
    const host = await createVoydHost({ wasm: result.wasm });

    await expect(host.run("shift", [{ x: 1, y: 2 }])).resolves.toEqual({
      x: 1,
      y: 2,
    });
  });

  it("can opt out of typed boundary export wrappers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: BOUNDARY_EXPORTS_SOURCE,
        boundaryExports: false,
      }),
    );
    const module = new WebAssembly.Module(wasmBufferSource(result.wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );

    expect(exports).toContain("translate");
    expect(exports).not.toContain("__voyd_serialized_export_translate");
    expect(abi.exports).toContainEqual({ name: "translate", abi: "direct" });
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

  it("keeps src-root imports when compiling nested entry paths", async () => {
    const sdk = createSdk();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-nested-src-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const entryDir = path.join(srcDir, "pkgs", "demo");
    const entryPath = path.join(entryDir, "main.voyd");

    await fs.mkdir(entryDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, "shared.voyd"),
      `pub fn value() -> i32
  42
`,
    );
    await fs.writeFile(
      entryPath,
      `use src::shared::all

pub fn main() -> i32
  value()
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

  it("detects the nearest src root for nested source files", () => {
    const entryPath = path.join(
      path.sep,
      "tmp",
      "voyd",
      "workspace",
      "src",
      "pkgs",
      "demo",
      "main.voyd",
    );

    expect(detectSrcRootForPath(entryPath)).toBe(
      path.join(path.sep, "tmp", "voyd", "workspace", "src"),
    );
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

  it("resolves scoped Voyd packages through bare pkg imports", async () => {
    const sdk = createSdk();
    const repoRoot = process.cwd();
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-voyd-sdk-scoped-node-modules-"),
    );
    const srcDir = path.join(projectRoot, "src");
    const entryPath = path.join(srcDir, "main.voyd");
    const packageSrcDir = path.join(
      projectRoot,
      "node_modules",
      "@voyd-lang",
      "web",
      "src",
    );

    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(packageSrcDir, { recursive: true });
    await fs.writeFile(
      entryPath,
      `use pkg::web::all

pub fn main() -> i32
  status(code: 204, reason: "No Content".as_slice()).status.code()
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "pkg.voyd"),
      `pub use src::response::status
`,
    );
    await fs.writeFile(
      path.join(packageSrcDir, "response.voyd"),
      `use std::http::{ Response, Status }
use std::string::type::StringSlice

pub fn status({ code: i32, reason: StringSlice }) -> Response
  match(Status::custom(code: code, reason: reason))
    Ok<Status> { value }:
      Response::new(status: value)
    Err:
      Response::internal_server_error()
`,
    );

    try {
      const result = expectCompileSuccess(await sdk.compile({ entryPath }));
      const output = await result.run<number>({ entryName: "main" });
      expect(output).toBe(204);
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
    const result = effectCompileResult;
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
    const result = effectCompileResult;
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
    const result = effectCompileResult;
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
use std::string::type::{ String, new_string }

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

  it("runs std input effects with default host adapters", async () => {
    const sdk = createSdk();
    const source = `use std::error::HostError
use std::input::read_line
use std::optional::types::all
use std::result::types::all
use std::string::type::{ String, new_string }

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
    host.registerHandler(
      op.effectId,
      op.opId,
      op.signatureHash,
      async ({ resume }, value) => {
        await Promise.resolve();
        return resume(value);
      },
    );
    host.initEffects();

    const left = host.runManaged<number>("first");
    const right = host.runManaged<number>("second");

    await expect(left.outcome).resolves.toEqual({ kind: "value", value: 11 });
    await expect(right.outcome).resolves.toEqual({ kind: "value", value: 22 });
  });

  it("[external-a] runs typed synchronous external functions through package adapters", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: EXTERNAL_SOURCE,
      }),
    );
    expect(result.external.functions).toMatchObject([
      {
        interfaceId: "example:math/ops@1",
        functionName: "double",
      },
    ]);
    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "example-math",
        functions: [
          {
            kind: "sync",
            interfaceId: "example:math/ops@1",
            functionName: "double",
            params: [{ kind: "i32" }],
            result: { kind: "i32" },
          },
        ],
      },
      {
        "example:math/ops@1": {
          double: (value: number) => value * 2,
        },
      },
    );

    await expect(
      result.run<number>({
        entryName: "main",
        adapters: [adapter],
      }),
    ).resolves.toBe(42);

    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-esm-adapter-"),
    );
    const packageRoot = path.join(projectRoot, "node_modules", "esm-only-math");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "esm-only-math",
        type: "module",
        exports: {
          "./adapter": {
            import: "./dist/adapter.js",
            development: "./adapter.js",
          },
        },
        voyd: {
          adapter: {
            abi: 1,
            interfaces: ["example:math/ops@1"],
            node: "./adapter",
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(packageRoot, "adapter.js"),
      `export default {
  kind: "voyd-package-adapter",
  contract: {
    abiVersion: 1,
    packageName: "esm-only-math",
    functions: [{
      kind: "sync",
      interfaceId: "example:math/ops@1",
      functionName: "double",
      params: [{ kind: "i32" }],
      result: { kind: "i32" }
    }]
  },
  implementation: {
    "example:math/ops@1": { double: (value) => value * 2 }
  }
};
`,
    );
    try {
      const discovered = await loadVoydPackageAdapters({
        wasm: result.wasm,
        startDir: projectRoot,
      });
      await expect(
        result.run<number>({
          entryName: "main",
          adapters: discovered,
        }),
      ).resolves.toBe(42);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }

    await expect(result.run<number>({ entryName: "main" })).rejects.toThrow(
      /Missing installed Voyd package adapters.*example:math\/ops@1/,
    );
  });

  it("[external-a] ignores duplicate providers for functions the module does not require", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        source: `@external(id: "example:required/a@1")
fn a() -> i32
  a()

@external(id: "example:required/b@1")
fn b() -> i32
  b()

pub fn main() -> i32
  a() + b()
`,
      }),
    );
    const scalar = { params: [], result: { kind: "i32" as const } };
    const shared = {
      kind: "sync" as const,
      interfaceId: "example:unused/c@1",
      functionName: "c",
      ...scalar,
    };
    const adapterA = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "provider-a",
        functions: [
          {
            kind: "sync",
            interfaceId: "example:required/a@1",
            functionName: "a",
            ...scalar,
          },
          shared,
        ],
      },
      {
        "example:required/a@1": { a: () => 1 },
        "example:unused/c@1": { c: () => 30 },
      },
    );
    const adapterB = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "provider-b",
        functions: [
          {
            kind: "sync",
            interfaceId: "example:required/b@1",
            functionName: "b",
            ...scalar,
          },
          shared,
        ],
      },
      {
        "example:required/b@1": { b: () => 2 },
        "example:unused/c@1": { c: () => 40 },
      },
    );

    await expect(
      result.run<number>({ entryName: "main", adapters: [adapterA, adapterB] }),
    ).resolves.toBe(3);
  });

  it("[external-a] detects duplicate required providers across nested node_modules", async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-adapter-discovery-"),
    );
    const nested = path.join(projectRoot, "packages", "app");
    const writeProvider = async (root: string, name: string) => {
      const packageRoot = path.join(root, "node_modules", name);
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name,
          voyd: {
            adapter: {
              abi: 1,
              interfaces: ["example:duplicate/service@1"],
              browser: "./adapter.js",
            },
          },
        }),
      );
    };
    try {
      await Promise.all([
        writeProvider(projectRoot, "provider-parent"),
        writeProvider(nested, "provider-child"),
      ]);
      await expect(
        findVoydPackageAdapterSpecifiers({
          interfaceIds: ["example:duplicate/service@1"],
          startDir: nested,
        }),
      ).rejects.toThrow(/Multiple installed Voyd package adapters/);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("[external-a] ignores unsupported adapter ABIs unless their interface is required", async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-adapter-abi-"),
    );
    const packageRoot = path.join(
      projectRoot,
      "node_modules",
      "future-provider",
    );
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "future-provider",
        voyd: {
          adapter: {
            abi: 2,
            interfaces: ["example:future/service@1"],
            browser: "./adapter.js",
          },
        },
      }),
    );
    try {
      await expect(
        findVoydPackageAdapterSpecifiers({
          interfaceIds: [],
          startDir: projectRoot,
        }),
      ).resolves.toEqual([]);
      await expect(
        findVoydPackageAdapterSpecifiers({
          interfaceIds: ["example:future/service@1"],
          startDir: projectRoot,
        }),
      ).rejects.toThrow(/unsupported ABI 2/);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("[external-a] does not mix metadata from a shadowed outer package version", async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(repoRoot, ".tmp-adapter-shadow-"),
    );
    const nested = path.join(projectRoot, "packages", "app");
    const writePackage = async (
      root: string,
      adapter: { abi: number; interfaces: string[]; browser?: string },
    ) => {
      const packageRoot = path.join(root, "node_modules", "same-provider");
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "same-provider",
          voyd: { adapter },
        }),
      );
    };
    try {
      await Promise.all([
        writePackage(projectRoot, {
          abi: 1,
          interfaces: ["example:shadowed/service@1"],
          browser: "./outer.js",
        }),
        writePackage(nested, { abi: 1, interfaces: [] }),
      ]);
      await expect(
        findVoydPackageAdapterSpecifiers({
          interfaceIds: ["example:shadowed/service@1"],
          startDir: nested,
        }),
      ).rejects.toThrow(/Missing installed Voyd package adapters/);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("[external-a] passes package adapters to compiled Voyd tests", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        includeTests: true,
        source: `use std::test::assertions::all

@external(id: "example:test/math@1")
fn double(value: i32) -> i32
  double(value)

test "external adapter":
  assert(double(2), eq: 4)
`,
      }),
    );
    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "test-math",
        functions: [
          {
            kind: "sync",
            interfaceId: "example:test/math@1",
            functionName: "double",
            params: [{ kind: "i32" }],
            result: { kind: "i32" },
          },
        ],
      },
      {
        "example:test/math@1": { double: (value: number) => value * 2 },
      },
    );

    expect(result.tests).toBeDefined();
    const summary = await result.tests!.run({ adapters: [adapter] });
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it("[external-b] auto-discovers adapters required only by the test Wasm", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        includeTests: true,
        source: `use pkg::markdown::to_static
use std::test::assertions::all

pub fn main() -> i32
  0

test "markdown adapter":
  assert(to_static("# Test").root, eq: 0)
`,
      }),
    );
    expect(result.tests).toBeDefined();

    const summary = await result.tests!.run({});
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it("[external-b] runs asynchronous external functions as Voyd effects", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        source: `use std::msgpack::self as __std_msgpack

@external(id: "example:async/ops@1")
eff Remote
  double(tail, value: i32) -> i32

pub fn main(): Remote -> i32
  Remote::double(21)
`,
      }),
    );
    expect(result.external.functions).toMatchObject([
      {
        kind: "async",
        interfaceId: "example:async/ops@1",
        functionName: "double",
      },
    ]);
    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "example-async",
        functions: [
          {
            kind: "async",
            interfaceId: "example:async/ops@1",
            functionName: "double",
            params: [{ kind: "i32" }],
            result: { kind: "i32" },
          },
        ],
      },
      {
        "example:async/ops@1": {
          double: async (value: number) => {
            await Promise.resolve();
            return value * 2;
          },
        },
      },
    );

    await expect(
      result.run<number>({ entryName: "main", adapters: [adapter] }),
    ).resolves.toBe(42);
  });

  it("[external-b] runs async external effects with structured and string DTOs regardless of source order", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        source: `use std::msgpack::self as __std_msgpack
use std::string::type::String
use std::string::self as __std_string

pub type Request = { url: String }
pub type Response = { status: i32, body: String }

@external(id: "example:http/client@1")
eff Http
  request(tail, input: Request) -> Response

fn unused(input: Request): Http -> Response
  Http::request(input)

pub fn main(): Http -> i32
  Http::request({ url: "https://example.test" }).status
`,
      }),
    );
    const requirement = result.external.functions[0]!;
    expect(requirement).toMatchObject({
      kind: "async",
      interfaceId: "example:http/client@1",
      functionName: "request",
    });
    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "example-http",
        functions: [
          {
            kind: "async",
            interfaceId: requirement.interfaceId,
            functionName: requirement.functionName,
            params: [
              {
                kind: "record",
                fields: [{ name: "url", schema: { kind: "string" } }],
              },
            ],
            result: {
              kind: "record",
              fields: [
                { name: "body", schema: { kind: "string" } },
                { name: "status", schema: { kind: "i32" } },
              ],
            },
          },
        ],
      },
      {
        "example:http/client@1": {
          request: async (input: { url: string }) => ({
            status: 200,
            body: `loaded ${input.url}`,
          }),
        },
      },
    );

    await expect(
      result.run<number>({ entryName: "main", adapters: [adapter] }),
    ).resolves.toBe(200);
  });

  it("[external-b] does not require adapters used only by unreachable private functions", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({
        source: `use std::msgpack::self as __std_msgpack

@external(id: "example:optional/remote@1")
eff Remote
  load(tail, value: i32) -> i32

fn unused(): Remote -> i32
  Remote::load(1)

pub fn main() -> i32
  7
`,
      }),
    );

    expect(result.external.functions).toEqual([]);
    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(7);
  });

  it("[external-b] rejects recursive external DTOs before runtime linking", async () => {
    const result = await createSdk().compile({
      source: `use std::optional::all

pub obj Node {
  api value: i32,
  api next?: Node
}

@external(id: "example:tree/model@1")
pub fn root() -> Node
  root()

pub fn main() -> i32
  root().value
`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toMatch(/recursive.*Component Model/);
  });
});
