import { describe, expect, it } from "vitest";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  getCompilerFunctionContractSpec,
} from "../../compiler-contracts/index.js";
import type {
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import { parse } from "../../parser/index.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type { HirFunction } from "../hir/index.js";
import { semanticsPipeline } from "../pipeline.js";

const analyze = ({ source, path }: { source: string; path: ModulePath }) => {
  const moduleId = `${path.namespace}::${path.segments.join("::")}`;
  const ast = parse(source, `${moduleId}.voyd`);
  const module: ModuleNode = {
    id: moduleId,
    path,
    origin: { kind: "file", filePath: `${moduleId}.voyd` },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleId,
    modules: new Map([[moduleId, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({ module, graph });
};

describe("compiler function contracts", () => {
  it("binds typed metadata without making an ordinary function intrinsic", () => {
    const contractId = BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull;
    const semantics = analyze({
      source: `@compiler_contract(id: "${contractId}")
fn contract_target() -> i32
  0`,
      path: { namespace: "std", segments: ["contract_test"] },
    });
    const symbolTable = getSymbolTable(semantics);
    const symbol = symbolTable.resolve(
      "contract_target",
      symbolTable.rootScope,
    );
    expect(symbol).toBeDefined();
    if (symbol === undefined) {
      return;
    }

    const spec = getCompilerFunctionContractSpec(contractId);
    expect(symbolTable.getSymbol(symbol).metadata).toMatchObject({
      entity: "function",
      compilerFunctionContract: spec,
    });
    expect(semantics.symbols.getCompilerFunctionContract(symbol)).toEqual(spec);
    expect(semantics.symbols.resolveCompilerFunctionContract(contractId)).toBe(
      symbol,
    );
    expect(semantics.symbols.getIntrinsicFunctionFlags(symbol)).toEqual({
      intrinsic: false,
      intrinsicUsesSignature: false,
    });

    const hirFunction = Array.from(semantics.hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === symbol,
    );
    expect(hirFunction?.intrinsic).toBeUndefined();
  });

  it("rejects contracts outside std, unknown ids, and wrong arity", () => {
    const contractId = BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull;
    expect(() =>
      analyze({
        source: `@compiler_contract(id: "${contractId}")
fn contract_target() -> i32
  0`,
        path: { namespace: "src", segments: ["contract_test"] },
      }),
    ).toThrow(/restricted to the std namespace/);

    expect(() =>
      analyze({
        source: `@compiler_contract(id: "voyd.std.boundary.unknown")
fn contract_target() -> i32
  0`,
        path: { namespace: "std", segments: ["unknown_contract_test"] },
      }),
    ).toThrow(/unknown @compiler_contract id/);

    expect(() =>
      analyze({
        source: `@compiler_contract(id: "${contractId}")
fn contract_target(value: i32) -> i32
  value`,
        path: { namespace: "std", segments: ["arity_contract_test"] },
      }),
    ).toThrow(/expects 0 parameter\(s\).*declares 1/);
  });
});
