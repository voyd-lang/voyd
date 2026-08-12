import { describe, expect, it } from "vitest";
import {
  DTO_DATA_CONTRACT_IDS,
  HOST_TRANSPORT_PROVIDER_CONTRACT,
  HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
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
    const contractId = DTO_DATA_CONTRACT_IDS.makeBool;
    const semantics = analyze({
      source: `@compiler_contract(id: "${contractId}")
fn contract_target(value: i32) -> i32
  value`,
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
    const contractId = DTO_DATA_CONTRACT_IDS.makeBool;
    expect(() =>
      analyze({
        source: `@compiler_contract(id: "${contractId}")
fn contract_target(value: i32) -> i32
  value`,
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
fn contract_target() -> i32
  0`,
        path: { namespace: "std", segments: ["arity_contract_test"] },
      }),
    ).toThrow(/expects 1 parameter\(s\).*declares 0/);
  });
});

describe("compiler trait contracts and implementations", () => {
  const providerSource = `@compiler_contract(id: "${HOST_TRANSPORT_PROVIDER_CONTRACT_ID}")
trait HostTransportProvider<Reader, Writer>
  fn create_reader(ptr: i32, len: i32) -> Reader
  fn reader_complete(reader: Reader) -> bool
  fn create_writer(ptr: i32, len: i32) -> Writer
  fn finish_writer(writer: Writer) -> i32

obj Reader {}
obj Writer {}
obj Provider {}

@compiler_impl(id: "example.transport", version: 3)
impl HostTransportProvider<Reader, Writer> for Provider
  fn create_reader(ptr: i32, len: i32) -> Reader
    Reader {}
  fn reader_complete(reader: Reader) -> bool
    true
  fn create_writer(ptr: i32, len: i32) -> Writer
    Writer {}
  fn finish_writer(writer: Writer) -> i32
    0`;

  it("binds the contract to the trait and identity to its impl", () => {
    const semantics = analyze({
      source: providerSource,
      path: { namespace: "std", segments: ["provider_contract_test"] },
    });
    const symbolTable = getSymbolTable(semantics);
    const trait = symbolTable.resolve(
      "HostTransportProvider",
      symbolTable.rootScope,
    );
    expect(trait).toBeDefined();
    if (trait === undefined) return;
    expect(semantics.symbols.getCompilerTraitContract(trait)).toEqual(
      HOST_TRANSPORT_PROVIDER_CONTRACT,
    );
    expect(
      semantics.symbols.resolveCompilerTraitContract(
        HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
      ),
    ).toBe(trait);
    expect(
      symbolTable
        .snapshot()
        .symbols.filter((record) => record?.metadata?.entity === "trait-method")
        .map((record) =>
          semantics.symbols.getCompilerTraitMethodRole(record!.id),
        ),
    ).toEqual([
      "createReader",
      "readerComplete",
      "createWriter",
      "finishWriter",
    ]);

    const impl = symbolTable
      .snapshot()
      .symbols.find(
        (record) =>
          record?.kind === "impl" &&
          semantics.symbols.getCompilerImplementation(record.id) !== undefined,
      );
    expect(impl).toBeDefined();
    if (!impl) return;
    expect(semantics.symbols.getCompilerImplementation(impl.id)).toEqual({
      id: "example.transport",
      version: 3,
    });
  });

  it("rejects compiler implementations of ordinary traits", () => {
    expect(() =>
      analyze({
        source: `trait Ordinary
  fn run() -> i32
obj Target {}
@compiler_impl(id: "example.ordinary", version: 1)
impl Ordinary for Target
  fn run() -> i32
    1`,
        path: { namespace: "std", segments: ["ordinary_impl_test"] },
      }),
    ).toThrow(/must implement a compiler-contract trait/);
  });

  it("rejects duplicate contract methods that omit another required role", () => {
    expect(() =>
      analyze({
        source: `@compiler_contract(id: "${HOST_TRANSPORT_PROVIDER_CONTRACT_ID}")
trait HostTransportProvider<Reader, Writer>
  fn create_reader(ptr: i32, len: i32) -> Reader
  fn create_reader(ptr: i32, len: i32) -> Reader
  fn reader_complete(reader: Reader) -> bool
  fn create_writer(ptr: i32, len: i32) -> Writer`,
        path: { namespace: "std", segments: ["duplicate_method_test"] },
      }),
    ).toThrow(/declares duplicate method 'create_reader'/);
  });
});
