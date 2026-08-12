import { describe, expect, it } from "vitest";
import type {
  CodegenFunctionSignature,
  CodegenTypeDesc,
  ProgramCodegenView,
} from "../../semantics/codegen-view/index.js";
import type { ProgramSymbolId, TypeId } from "../../semantics/ids.js";
import {
  COMPILER_FUNCTION_CONTRACTS,
  DTO_DATA_CONTRACT_IDS,
  STD_INTRINSIC_TYPE,
  validateDtoDataFunctionContracts,
  type CompilerContractTypeSpec,
  type CompilerFunctionContractId,
} from "../index.js";

const ids = { bool: 1, i32: 2, i64: 3, f32: 4, f64: 5 } as const;
const shared = {
  string: 11,
  bytes: 16,
  data: 17,
  dataArray: 18,
  dataMap: 19,
} as const;
const fixed = { i32: 15, data: 20 } as const;
const owners = {
  string: 101 as ProgramSymbolId,
  array: 102 as ProgramSymbolId,
  map: 103 as ProgramSymbolId,
  bytes: 104 as ProgramSymbolId,
} as const;

const typeIdFor = (spec: CompilerContractTypeSpec): TypeId => {
  if (spec.kind === "primitive") return ids[spec.name] as TypeId;
  if (spec.kind === "shared") {
    return {
      string: shared.string,
      bytes: shared.bytes,
      data: shared.data,
      "data-array": shared.dataArray,
      "data-map": shared.dataMap,
    }[spec.name] as TypeId;
  }
  if (spec.element.kind === "primitive") return fixed.i32 as TypeId;
  return fixed.data as TypeId;
};

const makeProgramFor = (
  contractIds: readonly CompilerFunctionContractId[],
  mutate?: (
    signatures: Map<CompilerFunctionContractId, CodegenFunctionSignature>,
  ) => void,
): ProgramCodegenView => {
  const signatures = new Map<
    CompilerFunctionContractId,
    CodegenFunctionSignature
  >();
  contractIds.forEach((contractId, index) => {
    const spec = COMPILER_FUNCTION_CONTRACTS.get(contractId)!;
    signatures.set(contractId, {
      typeId: 1000 + index,
      scheme: 2000 + index,
      parameters: spec.signature.parameters.map((parameter) => ({
        typeId: typeIdFor(parameter.type),
        optional: false,
      })),
      returnType: typeIdFor(spec.signature.result),
      effectRow: 0,
      typeParams: [],
    } as CodegenFunctionSignature);
  });
  mutate?.(signatures);

  const descriptors = new Map<number, CodegenTypeDesc>([
    [ids.bool, { kind: "primitive", name: "bool" }],
    [ids.i32, { kind: "primitive", name: "i32" }],
    [ids.i64, { kind: "primitive", name: "i64" }],
    [ids.f32, { kind: "primitive", name: "f32" }],
    [ids.f64, { kind: "primitive", name: "f64" }],
    [shared.data, { kind: "union", members: [] }],
    [
      shared.bytes,
      {
        kind: "nominal-object",
        owner: owners.bytes,
        name: "Bytes",
        typeArgs: [],
      },
    ],
    [
      shared.string,
      {
        kind: "nominal-object",
        owner: owners.string,
        name: "String",
        typeArgs: [],
      },
    ],
    [
      shared.dataArray,
      {
        kind: "nominal-object",
        owner: owners.array,
        name: "Array",
        typeArgs: [shared.data],
      },
    ],
    [
      shared.dataMap,
      {
        kind: "nominal-object",
        owner: owners.map,
        name: "Dict",
        typeArgs: [shared.string, shared.data],
      },
    ],
    [fixed.i32, { kind: "fixed-array", element: ids.i32 }],
    [fixed.data, { kind: "fixed-array", element: shared.data }],
  ]);
  const contractBySymbol = new Map(
    contractIds.map((contractId, index) => [index, contractId]),
  );
  const symbolByContract = new Map<CompilerFunctionContractId, number>(
    contractIds.map((contractId, index) => [contractId, index]),
  );

  return {
    primitives: { ...ids, void: 6, unknown: 7, defaultEffectRow: 0 },
    effects: { isEmpty: (row: number) => row === 0 },
    types: {
      getTypeDesc: (typeId: number) => descriptors.get(typeId)!,
      unify: (left: number, right: number) =>
        left === right
          ? { ok: true, substitution: new Map() }
          : { ok: false, conflict: { left, right, message: "different" } },
    },
    symbols: {
      resolveCompilerFunctionContract: (id: CompilerFunctionContractId) =>
        symbolByContract.get(id),
      refOf: (symbol: number) => ({ moduleId: "std::contracts", symbol }),
      canonicalIdOf: (_moduleId: string, symbol: number) => symbol,
      getPackageId: () => "std",
      getName: (owner: number) =>
        owner === owners.string
          ? "String"
          : owner === owners.array
            ? "Array"
            : owner === owners.bytes
              ? "Bytes"
              : "Dict",
      getStdIntrinsicTypeContract: (owner: number) =>
        owner === owners.string
          ? { id: STD_INTRINSIC_TYPE.string, providerKind: "nominal-object" }
          : owner === owners.array
            ? { id: STD_INTRINSIC_TYPE.array, providerKind: "nominal-object" }
            : owner === owners.bytes
              ? { id: STD_INTRINSIC_TYPE.bytes, providerKind: "nominal-object" }
              : undefined,
    },
    functions: {
      getSignature: (_moduleId: string, symbol: number) => {
        const contractId = contractBySymbol.get(symbol);
        return contractId ? signatures.get(contractId) : undefined;
      },
    },
  } as unknown as ProgramCodegenView;
};

const makeDataProgram = (
  mutate?: (
    signatures: Map<CompilerFunctionContractId, CodegenFunctionSignature>,
  ) => void,
): ProgramCodegenView =>
  makeProgramFor(Object.values(DTO_DATA_CONTRACT_IDS), mutate);

const replace = (
  signatures: Map<CompilerFunctionContractId, CodegenFunctionSignature>,
  id: CompilerFunctionContractId,
  update: Partial<CodegenFunctionSignature>,
) => signatures.set(id, { ...signatures.get(id)!, ...update });

describe("dto-data compiler contract signature validation", () => {
  it("accepts the complete relational ABI", () => {
    expect(validateDtoDataFunctionContracts(makeDataProgram())).toEqual({
      data: shared.data,
      string: shared.string,
      bytes: shared.bytes,
      array: shared.dataArray,
      map: shared.dataMap,
    });
  });

  it("rejects a provider whose map value relation drifts", () => {
    const invalid = makeDataProgram((signatures) => {
      const id = DTO_DATA_CONTRACT_IDS.mapSet;
      const signature = signatures.get(id)!;
      replace(signatures, id, {
        parameters: signature.parameters.map((parameter, index) =>
          index === 2 ? { ...parameter, typeId: ids.bool } : parameter,
        ),
      });
    });

    expect(() => validateDtoDataFunctionContracts(invalid)).toThrow(
      /map-set.*parameter 3 expected DataValue, got bool/,
    );
  });
});
