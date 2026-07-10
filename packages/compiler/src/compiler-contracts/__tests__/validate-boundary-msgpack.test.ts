import { describe, expect, it } from "vitest";
import type {
  CodegenFunctionSignature,
  CodegenTypeDesc,
  ProgramCodegenView,
} from "../../semantics/codegen-view/index.js";
import type { ProgramSymbolId, TypeId } from "../../semantics/ids.js";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  COMPILER_FUNCTION_CONTRACTS,
  STD_INTRINSIC_TYPE,
  validateBoundaryMsgpackFunctionContracts,
  type CompilerContractTypeSpec,
  type CompilerFunctionContractId,
} from "../index.js";

const ids = { bool: 1, i32: 2, i64: 3, f32: 4, f64: 5 } as const;
const shared = { msgpack: 10, string: 11, array: 12, map: 13 } as const;
const fixed = { msgpack: 14, i32: 15 } as const;
const owners = {
  string: 101 as ProgramSymbolId,
  array: 102 as ProgramSymbolId,
  map: 103 as ProgramSymbolId,
} as const;

const typeIdFor = (spec: CompilerContractTypeSpec): TypeId => {
  if (spec.kind === "primitive") return ids[spec.name] as TypeId;
  if (spec.kind === "shared") {
    return ({
      msgpack: shared.msgpack,
      string: shared.string,
      "msgpack-array": shared.array,
      "msgpack-map": shared.map,
    })[spec.name] as TypeId;
  }
  return (spec.element.kind === "primitive" ? fixed.i32 : fixed.msgpack) as TypeId;
};

const makeProgram = (
  mutate?: (
    signatures: Map<CompilerFunctionContractId, CodegenFunctionSignature>,
  ) => void,
): ProgramCodegenView => {
  const contractIds = Object.values(BOUNDARY_MSGPACK_CONTRACT_IDS);
  const signatures = new Map<CompilerFunctionContractId, CodegenFunctionSignature>();
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
    [shared.msgpack, { kind: "union", members: [] }],
    [shared.string, { kind: "nominal-object", owner: owners.string, name: "String", typeArgs: [] }],
    [shared.array, { kind: "nominal-object", owner: owners.array, name: "Array", typeArgs: [shared.msgpack] }],
    [shared.map, { kind: "nominal-object", owner: owners.map, name: "Dict", typeArgs: [shared.string, shared.msgpack] }],
    [fixed.msgpack, { kind: "fixed-array", element: shared.msgpack }],
    [fixed.i32, { kind: "fixed-array", element: ids.i32 }],
  ]);
  const contractBySymbol = new Map(contractIds.map((contractId, index) => [index, contractId]));
  const symbolByContract = new Map(contractIds.map((contractId, index) => [contractId, index]));

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
      resolveCompilerFunctionContract: (id: CompilerFunctionContractId) => symbolByContract.get(id),
      refOf: (symbol: number) => ({ moduleId: "std::contracts", symbol }),
      getPackageId: () => "std",
      getName: (owner: number) => owner === owners.string ? "String" : owner === owners.array ? "Array" : "Dict",
      getStdIntrinsicTypeContract: (owner: number) =>
        owner === owners.string
          ? { id: STD_INTRINSIC_TYPE.string, providerKind: "nominal-object" }
          : owner === owners.array
            ? { id: STD_INTRINSIC_TYPE.array, providerKind: "nominal-object" }
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

const replace = (
  signatures: Map<CompilerFunctionContractId, CodegenFunctionSignature>,
  id: CompilerFunctionContractId,
  update: Partial<CodegenFunctionSignature>,
) => signatures.set(id, { ...signatures.get(id)!, ...update });

describe("boundary-msgpack compiler contract signature validation", () => {
  it("accepts the complete relational ABI", () => {
    expect(validateBoundaryMsgpackFunctionContracts(makeProgram())).toEqual(shared);
  });

  it("rejects wrong parameter and result types with the contract and signatures", () => {
    const wrongParameter = makeProgram((signatures) => {
      const id = BOUNDARY_MSGPACK_CONTRACT_IDS.encodeValue;
      const signature = signatures.get(id)!;
      replace(signatures, id, {
        parameters: signature.parameters.map((parameter, index) =>
          index === 1 ? { ...parameter, typeId: ids.bool } : parameter),
      });
    });
    expect(() => validateBoundaryMsgpackFunctionContracts(wrongParameter)).toThrow(
      /encode-value.*expected \(MsgPack, i32, i32\).*parameter 2 expected i32, got bool/,
    );

    const wrongResult = makeProgram((signatures) =>
      replace(signatures, BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull, {
        returnType: ids.bool,
      }),
    );
    expect(() => validateBoundaryMsgpackFunctionContracts(wrongResult)).toThrow(
      /make-null.*result expected MsgPack, got bool/,
    );
  });

  it("rejects generic, optional, and effectful providers", () => {
    const generic = makeProgram((signatures) =>
      replace(signatures, BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull, {
        typeParams: [{ symbol: 1, typeParam: 1, typeRef: 1 }],
      }),
    );
    expect(() => validateBoundaryMsgpackFunctionContracts(generic)).toThrow(
      /make-null.*expected no type parameters, got 1/,
    );

    const optional = makeProgram((signatures) => {
      const id = BOUNDARY_MSGPACK_CONTRACT_IDS.makeBool;
      const signature = signatures.get(id)!;
      replace(signatures, id, {
        parameters: [{ ...signature.parameters[0]!, optional: true }],
      });
    });
    expect(() => validateBoundaryMsgpackFunctionContracts(optional)).toThrow(
      /make-bool.*parameter 1 must not be optional/,
    );

    const effectful = makeProgram((signatures) =>
      replace(signatures, BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull, { effectRow: 1 }),
    );
    expect(() => validateBoundaryMsgpackFunctionContracts(effectful)).toThrow(
      /make-null.*expected a pure effect row/,
    );
  });
});
