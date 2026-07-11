import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import { buildProgramSymbolArena } from "../semantics/program-symbol-arena.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import { parse } from "../parser/index.js";
import { semanticsPipeline } from "../semantics/pipeline.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  STD_INTRINSIC_TYPE,
} from "../compiler-contracts/index.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const analyzeContractModule = ({
  name,
  contractId,
}: {
  name: string;
  contractId: string;
}) => {
  const path: ModulePath = { namespace: "std", segments: [name] };
  const moduleId = `std::${name}`;
  const source = `@compiler_contract(id: "${contractId}")
fn contract_target() -> i32
  0`;
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

const analyzeIntrinsicTypeModule = ({
  name,
  typeName,
  intrinsicType,
}: {
  name: string;
  typeName: string;
  intrinsicType: string;
}) => {
  const path: ModulePath = { namespace: "std", segments: [name] };
  const moduleId = `std::${name}`;
  const source = `@intrinsic_type(type: "${intrinsicType}")
obj ${typeName} {}`;
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

describe("ProgramSymbolArena", () => {
  it("assigns deterministic ids independent of module order", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::util::all

pub fn main() -> i32
  add(1, 2)`,
      [`${root}${sep}util.voyd`]: `pub use self::math::all`,
      [`${root}${sep}util${sep}math.voyd`]: `pub fn add(a: i32, b: i32) -> i32
  a + b`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.filter((diag) => diag.severity === "error")).toHaveLength(0);

    const modules = Array.from(semantics.values());
    const arenaA = buildProgramSymbolArena(modules);
    const arenaB = buildProgramSymbolArena([...modules].reverse());

    const refs: { moduleId: string; symbol: number }[] = [];
    modules.forEach((mod) => {
      const snapshot = getSymbolTable(mod).snapshot();
      snapshot.symbols.forEach((record) => {
        if (!record) return;
        refs.push({ moduleId: mod.moduleId, symbol: record.id });
      });
    });

    const idsA = refs.map((ref) => arenaA.idOf(ref));
    const idsB = refs.map((ref) => arenaB.idOf(ref));

    expect(idsA).toEqual(idsB);

    const unique = new Set<number>(idsA);
    expect(unique.size).toBe(idsA.length);
    expect(Math.min(...idsA)).toBe(0);
    expect(Math.max(...idsA)).toBe(idsA.length - 1);
  });

  it("rejects duplicate contract declarations deterministically", () => {
    const contractId = BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull;
    const left = analyzeContractModule({ name: "left", contractId });
    const right = analyzeContractModule({ name: "right", contractId });

    const captureError = (modules: (typeof left)[]) => {
      try {
        buildProgramSymbolArena(modules);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected duplicate contract detection");
    };

    const forward = captureError([left, right]);
    const reverse = captureError([right, left]);
    expect(forward).toBe(reverse);
    expect(forward).toMatch(
      /duplicate compiler function contract 'voyd\.std\.boundary\.msgpack\.make-null'/,
    );
    expect(forward).toMatch(/std::left.*std::right/);
  });

  it("rejects duplicate reserved intrinsic type providers deterministically", () => {
    const left = analyzeIntrinsicTypeModule({
      name: "intrinsic_left",
      typeName: "LeftSomeProvider",
      intrinsicType: STD_INTRINSIC_TYPE.optionalSome,
    });
    const right = analyzeIntrinsicTypeModule({
      name: "intrinsic_right",
      typeName: "RightSomeProvider",
      intrinsicType: STD_INTRINSIC_TYPE.optionalSome,
    });

    const captureError = (modules: (typeof left)[]) => {
      try {
        buildProgramSymbolArena(modules);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected duplicate intrinsic type provider detection");
    };

    const forward = captureError([left, right]);
    const reverse = captureError([right, left]);
    expect(forward).toBe(reverse);
    expect(forward).toMatch(
      /duplicate reserved std intrinsic type contract 'optional-some'/,
    );
    expect(forward).toMatch(/std::intrinsic_left.*std::intrinsic_right/);
  });

  it("does not expose compiler contracts on imported aliases", async () => {
    const srcRoot = resolve("/contract-alias/src");
    const stdRoot = resolve("/contract-alias/std");
    const contractId = BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull;
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `use std::{ contract_target }

pub fn main() -> i32
  contract_target()`,
      [`${stdRoot}${sep}pkg.voyd`]: `pub use self::contracts::{ contract_target }`,
      [`${stdRoot}${sep}contracts.voyd`]: `@compiler_contract(id: "${contractId}")
pub fn contract_target() -> i32
  0`,
    });
    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });
    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(
      diagnostics.filter((diag) => diag.severity === "error"),
    ).toHaveLength(0);

    const main = semantics.get("src::main");
    const contracts = semantics.get("std::contracts");
    expect(main).toBeDefined();
    expect(contracts).toBeDefined();
    if (!main || !contracts) {
      return;
    }
    const mainSymbols = getSymbolTable(main);
    const alias = mainSymbols.resolve("contract_target", mainSymbols.rootScope);
    expect(alias).toBeDefined();
    if (alias === undefined) {
      return;
    }
    expect(main.symbols.getCompilerFunctionContract(alias)).toBeUndefined();

    const arena = buildProgramSymbolArena(Array.from(semantics.values()));
    const resolved = arena.resolveCompilerFunctionContract(contractId);
    expect(resolved).toBeDefined();
    if (resolved !== undefined) {
      expect(arena.refOf(resolved).moduleId).toBe("std::contracts");
    }
  });

  it("indexes only the declaring reserved intrinsic type provider", async () => {
    const srcRoot = resolve("/intrinsic-type-alias/src");
    const stdRoot = resolve("/intrinsic-type-alias/std");
    const host = createMemoryHost({
      [`${srcRoot}${sep}main.voyd`]: `use std::{ ArrayProvider }

pub fn main(value: ArrayProvider) -> ArrayProvider
  value`,
      [`${stdRoot}${sep}pkg.voyd`]: `pub use self::types::{ ArrayProvider }`,
      [`${stdRoot}${sep}types.voyd`]: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.array}")
pub obj ArrayProvider {}`,
    });
    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });
    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(
      diagnostics.filter((diag) => diag.severity === "error"),
    ).toHaveLength(0);

    const main = semantics.get("src::main");
    const provider = semantics.get("std::types");
    expect(main).toBeDefined();
    expect(provider).toBeDefined();
    if (!main || !provider) {
      return;
    }
    const mainSymbols = getSymbolTable(main);
    const alias = mainSymbols.resolve("ArrayProvider", mainSymbols.rootScope);
    expect(alias).toBeDefined();
    if (alias === undefined) {
      return;
    }
    expect(main.symbols.getIntrinsicType(alias)).toBe(
      STD_INTRINSIC_TYPE.array,
    );
    expect(main.symbols.getStdIntrinsicTypeContract(alias)).toBeUndefined();

    const arena = buildProgramSymbolArena(Array.from(semantics.values()));
    const resolved = arena.resolveStdIntrinsicTypeContract(
      STD_INTRINSIC_TYPE.array,
    );
    expect(resolved).toBeDefined();
    if (resolved !== undefined) {
      expect(arena.refOf(resolved).moduleId).toBe("std::types");
    }
  });
});
