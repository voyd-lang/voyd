import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenContext, FunctionMetadata } from "../context.js";
import {
  MSGPACK_HOST_TRANSPORT_CONTRACT_IDS,
  SELECTED_HOST_TRANSPORT_CONTRACT_IDS,
} from "../../compiler-contracts/index.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import { gcTrampolineAbiStrategy } from "../effects/gc-trampoline-abi-strategy.js";
import { requireFunctionMetaByCompilerContract } from "../function-lookup.js";

const CONTRACT_ID = MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createReader;
const CODEGEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFilesUnder = (root: string): string[] =>
  readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory()
      ? sourceFilesUnder(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];
  });

describe("compiler function contract lookup", () => {
  it("resolves codegen metadata without depending on module or function names", () => {
    const meta = {
      moduleId: "renamed::implementation",
      symbol: 71,
      typeArgs: [],
    } as unknown as FunctionMetadata;
    const ctx = {
      program: {
        symbols: {
          resolveCompilerFunctionContract: (id: string) =>
            id === CONTRACT_ID ? 19 : undefined,
          refOf: () => ({ moduleId: meta.moduleId, symbol: meta.symbol }),
        },
      },
      functions: new Map([[meta.moduleId, new Map([[meta.symbol, [meta]]])]]),
    } as unknown as CodegenContext;

    expect(
      requireFunctionMetaByCompilerContract({ ctx, contractId: CONTRACT_ID }),
    ).toBe(meta);
  });

  it("names a missing required contract in the failure", () => {
    const ctx = {
      program: {
        symbols: {
          resolveCompilerFunctionContract: () => undefined,
        },
      },
    } as unknown as CodegenContext;

    expect(() =>
      requireFunctionMetaByCompilerContract({ ctx, contractId: CONTRACT_ID }),
    ).toThrow(`missing compiler function contract '${CONTRACT_ID}'`);
  });
});

describe("effect host-boundary compiler contracts", () => {
  it("reports missing contracts before emitting the boundary", () => {
    const diagnostics = new DiagnosticEmitter();
    const resolveCompilerFunctionContract = vi.fn(() => undefined);
    const entryCtx = {
      options: { effectsHostBoundary: "selected" },
      program: { symbols: { resolveCompilerFunctionContract } },
      diagnostics,
      module: {
        hir: { module: { span: { file: "main.voyd", start: 0, end: 1 } } },
      },
    } as unknown as CodegenContext;

    gcTrampolineAbiStrategy.emitHostBoundary({
      entryCtx,
      contexts: [entryCtx],
      effectfulExports: [{ meta: { effectRow: 1 }, exportName: "main" }],
    });

    expect(resolveCompilerFunctionContract).toHaveBeenCalledTimes(
      SELECTED_HOST_TRANSPORT_CONTRACT_IDS.length,
    );
    expect(diagnostics.diagnostics).toHaveLength(1);
    expect(diagnostics.diagnostics[0]?.message).toContain(
      "effectful exports require the selected host-transport compiler contracts",
    );
    expect(diagnostics.diagnostics[0]?.message).toContain(CONTRACT_ID);
  });
});

describe("generic host transport architecture", () => {
  it("keeps provider format names out of generic boundary code", () => {
    const genericRoots = [
      resolve(CODEGEN_ROOT, "boundary"),
      resolve(CODEGEN_ROOT, "effects/host-boundary"),
      resolve(CODEGEN_ROOT, "exports"),
      resolve(CODEGEN_ROOT, "external"),
    ];

    genericRoots.flatMap(sourceFilesUnder).forEach((path) => {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/msgpack/iu);
    });
  });
});
