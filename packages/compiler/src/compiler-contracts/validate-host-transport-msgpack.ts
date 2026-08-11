import type {
  CodegenFunctionSignature,
  CodegenTypeDesc,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import type { NodeId, TypeId } from "../semantics/ids.js";
import {
  MSGPACK_HOST_TRANSPORT_CONTRACT_IDS,
  COMPILER_FUNCTION_CONTRACTS,
  DTO_DATA_CONTRACT_IDS,
  type CompilerContractSharedType,
  type CompilerContractTypeSpec,
  type CompilerFunctionContractId,
  type CompilerFunctionContractSpec,
} from "./function-contracts.js";
import { isStdIntrinsicNominalType, STD_INTRINSIC_TYPE } from "./types.js";

type ResolvedContract = {
  spec: CompilerFunctionContractSpec;
  signature: CodegenFunctionSignature;
};

export type MsgpackHostTransportContractTypes = {
  readonly msgpack: TypeId;
  readonly string: TypeId;
  readonly bytes: TypeId;
  readonly array: TypeId;
  readonly map: TypeId;
  readonly reader: TypeId;
  readonly writer: TypeId;
};

export type DtoDataContractTypes = {
  readonly data: TypeId;
  readonly string: TypeId;
  readonly bytes: TypeId;
  readonly array: TypeId;
  readonly map: TypeId;
};

type ContractTypes = Partial<Record<CompilerContractSharedType, TypeId>>;

/** Validates the complete relational ABI for the selected MessagePack transport. */
export const validateMsgpackHostTransportFunctionContracts = (
  program: ProgramCodegenView,
): MsgpackHostTransportContractTypes => {
  const resolved = new Map<CompilerFunctionContractId, ResolvedContract>();
  Object.values(MSGPACK_HOST_TRANSPORT_CONTRACT_IDS).forEach((contractId) => {
    const programSymbol =
      program.symbols.resolveCompilerFunctionContract(contractId);
    if (typeof programSymbol !== "number") {
      throw new Error(`missing compiler function contract '${contractId}'`);
    }
    const ref = program.symbols.refOf(programSymbol);
    const signature = program.functions.getSignature(ref.moduleId, ref.symbol);
    if (!signature) {
      throw new Error(
        `compiler function contract '${contractId}' has no typed signature`,
      );
    }
    resolved.set(contractId, {
      spec: COMPILER_FUNCTION_CONTRACTS.get(contractId)!,
      signature,
    });
  });

  const types: MsgpackHostTransportContractTypes = {
    msgpack: parameterType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.encodeValue,
      0,
    ),
    string: parameterType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeString,
      0,
    ),
    bytes: parameterType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeBytes,
      0,
    ),
    array: parameterType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeArray,
      0,
    ),
    map: parameterType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeMap,
      0,
    ),
    reader: resultType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createReader,
    ),
    writer: resultType(
      resolved,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createWriter,
    ),
  };
  const sharedTypes: ContractTypes = {
    msgpack: types.msgpack,
    string: types.string,
    bytes: types.bytes,
    "msgpack-array": types.array,
    "msgpack-map": types.map,
    "msgpack-reader": types.reader,
    "msgpack-writer": types.writer,
  };

  validateSharedDomainTypes(program, types);
  resolved.forEach(({ spec, signature }) =>
    validateSignature({ program, spec, signature, types: sharedTypes }),
  );
  return types;
};

/** Validates the relational ABI for the provider-neutral DataValue tree. */
export const validateDtoDataFunctionContracts = (
  program: ProgramCodegenView,
): DtoDataContractTypes => {
  const resolved = resolveContracts(
    program,
    Object.values(DTO_DATA_CONTRACT_IDS),
  );
  const types: DtoDataContractTypes = {
    data: resultType(resolved, DTO_DATA_CONTRACT_IDS.makeNull),
    string: parameterType(resolved, DTO_DATA_CONTRACT_IDS.makeString, 0),
    bytes: parameterType(resolved, DTO_DATA_CONTRACT_IDS.makeBytes, 0),
    array: parameterType(resolved, DTO_DATA_CONTRACT_IDS.makeArray, 0),
    map: parameterType(resolved, DTO_DATA_CONTRACT_IDS.makeMap, 0),
  };
  const sharedTypes: ContractTypes = {
    data: types.data,
    string: types.string,
    bytes: types.bytes,
    "data-array": types.array,
    "data-map": types.map,
  };
  validateDtoDataSharedDomainTypes(program, types);
  resolved.forEach(({ spec, signature }) =>
    validateSignature({ program, spec, signature, types: sharedTypes }),
  );
  return types;
};

const resolveContracts = (
  program: ProgramCodegenView,
  contractIds: readonly CompilerFunctionContractId[],
): Map<CompilerFunctionContractId, ResolvedContract> => {
  const resolved = new Map<CompilerFunctionContractId, ResolvedContract>();
  contractIds.forEach((contractId) => {
    const programSymbol =
      program.symbols.resolveCompilerFunctionContract(contractId);
    if (typeof programSymbol !== "number") {
      throw new Error(`missing compiler function contract '${contractId}'`);
    }
    const ref = program.symbols.refOf(programSymbol);
    const signature = program.functions.getSignature(ref.moduleId, ref.symbol);
    if (!signature) {
      throw new Error(
        `compiler function contract '${contractId}' has no typed signature`,
      );
    }
    resolved.set(contractId, {
      spec: COMPILER_FUNCTION_CONTRACTS.get(contractId)!,
      signature,
    });
  });
  return resolved;
};

const resultType = (
  resolved: ReadonlyMap<CompilerFunctionContractId, ResolvedContract>,
  contractId: CompilerFunctionContractId,
): TypeId => {
  const value = resolved.get(contractId)?.signature.returnType;
  if (typeof value !== "number") {
    throw new Error(
      `compiler function contract '${contractId}' is missing a result`,
    );
  }
  return value;
};

const parameterType = (
  resolved: ReadonlyMap<CompilerFunctionContractId, ResolvedContract>,
  contractId: CompilerFunctionContractId,
  index: number,
): TypeId => {
  const value = resolved.get(contractId)?.signature.parameters[index]?.typeId;
  if (typeof value !== "number") {
    throw new Error(
      `compiler function contract '${contractId}' is missing parameter ${index + 1}`,
    );
  }
  return value;
};

const validateSharedDomainTypes = (
  program: ProgramCodegenView,
  types: MsgpackHostTransportContractTypes,
): void => {
  if (
    !isStdIntrinsicNominalType({
      program,
      typeId: types.string,
      intrinsicType: STD_INTRINSIC_TYPE.string,
    })
  ) {
    throwDomainTypeError(
      program,
      "string",
      "the std String nominal type",
      types.string,
    );
  }
  if (
    !isStdIntrinsicNominalType({
      program,
      typeId: types.bytes,
      intrinsicType: STD_INTRINSIC_TYPE.bytes,
    })
  ) {
    throwDomainTypeError(
      program,
      "bytes",
      "the std Bytes nominal type",
      types.bytes,
    );
  }
  if (
    !isStdIntrinsicNominalType({
      program,
      typeId: types.array,
      intrinsicType: STD_INTRINSIC_TYPE.array,
    })
  ) {
    throwDomainTypeError(
      program,
      "msgpack-array",
      "the std Array nominal type",
      types.array,
    );
  }
  const arrayArgs = nominalTypeArgs(program, types.array);
  if (
    arrayArgs.length !== 1 ||
    !sameContractType(program, arrayArgs[0]!, types.msgpack)
  ) {
    throwDomainTypeError(
      program,
      "msgpack-array",
      "Array<MsgPack>",
      types.array,
    );
  }
  const mapArgs = nominalTypeArgs(program, types.map);
  if (
    mapArgs.length !== 2 ||
    !sameContractType(program, mapArgs[0]!, types.string) ||
    !sameContractType(program, mapArgs[1]!, types.msgpack)
  ) {
    throwDomainTypeError(
      program,
      "msgpack-map",
      "Map<String, MsgPack>",
      types.map,
    );
  }
};

const validateDtoDataSharedDomainTypes = (
  program: ProgramCodegenView,
  types: DtoDataContractTypes,
): void => {
  if (
    !isStdIntrinsicNominalType({
      program,
      typeId: types.string,
      intrinsicType: STD_INTRINSIC_TYPE.string,
    })
  ) {
    throwDomainTypeError(
      program,
      "string",
      "the std String nominal type",
      types.string,
    );
  }
  if (
    !isStdIntrinsicNominalType({
      program,
      typeId: types.bytes,
      intrinsicType: STD_INTRINSIC_TYPE.bytes,
    })
  ) {
    throwDomainTypeError(
      program,
      "bytes",
      "the std Bytes nominal type",
      types.bytes,
    );
  }
  const arrayArgs = nominalTypeArgs(program, types.array);
  if (
    arrayArgs.length !== 1 ||
    !sameContractType(program, arrayArgs[0]!, types.data)
  ) {
    throwDomainTypeError(
      program,
      "data-array",
      "Array<DataValue>",
      types.array,
    );
  }
  const mapArgs = nominalTypeArgs(program, types.map);
  if (
    mapArgs.length !== 2 ||
    !sameContractType(program, mapArgs[0]!, types.string) ||
    !sameContractType(program, mapArgs[1]!, types.data)
  ) {
    throwDomainTypeError(
      program,
      "data-map",
      "Dict<String, DataValue>",
      types.map,
    );
  }
};

const nominalTypeArgs = (
  program: ProgramCodegenView,
  typeId: TypeId,
): readonly TypeId[] => {
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return nominalTypeArgs(program, desc.nominal);
  }
  return desc.kind === "nominal-object" || desc.kind === "value-object"
    ? desc.typeArgs
    : [];
};

const throwDomainTypeError = (
  program: ProgramCodegenView,
  role: CompilerContractSharedType,
  expected: string,
  actual: TypeId,
): never => {
  throw new Error(
    `host-transport-msgpack shared type '${role}' expected ${expected}, but actual type is ${formatType(program, actual)}`,
  );
};

const validateSignature = ({
  program,
  spec,
  signature,
  types,
}: {
  program: ProgramCodegenView;
  spec: CompilerFunctionContractSpec;
  signature: CodegenFunctionSignature;
  types: ContractTypes;
}): void => {
  const mismatch = signatureMismatch({ program, spec, signature, types });
  if (!mismatch) return;
  throw new Error(
    `compiler function contract '${spec.id}' expected ${formatExpectedSignature(spec)}, but actual signature is ${formatActualSignature(program, signature)} (${mismatch})`,
  );
};

const signatureMismatch = ({
  program,
  spec,
  signature,
  types,
}: {
  program: ProgramCodegenView;
  spec: CompilerFunctionContractSpec;
  signature: CodegenFunctionSignature;
  types: ContractTypes;
}): string | undefined => {
  if (signature.typeParams.length !== spec.signature.typeParameters) {
    return `expected no type parameters, got ${signature.typeParams.length}`;
  }
  if (signature.parameters.length !== spec.signature.parameters.length) {
    return `expected ${spec.signature.parameters.length} parameters, got ${signature.parameters.length}`;
  }
  const optionalIndex = signature.parameters.findIndex(
    (parameter) => parameter.optional,
  );
  if (optionalIndex >= 0)
    return `parameter ${optionalIndex + 1} must not be optional`;
  if (!program.effects.isEmpty(signature.effectRow))
    return "expected a pure effect row";

  const parameterMismatch = spec.signature.parameters.findIndex(
    (expected, index) =>
      !matchesType({
        program,
        expected: expected.type,
        actual: signature.parameters[index]!.typeId,
        types,
      }),
  );
  if (parameterMismatch >= 0) {
    const expected = spec.signature.parameters[parameterMismatch]!.type;
    const actual = signature.parameters[parameterMismatch]!.typeId;
    return `parameter ${parameterMismatch + 1} expected ${formatExpectedType(expected)}, got ${formatType(program, actual)}`;
  }
  if (
    !matchesType({
      program,
      expected: spec.signature.result,
      actual: signature.returnType,
      types,
    })
  ) {
    return `result expected ${formatExpectedType(spec.signature.result)}, got ${formatType(program, signature.returnType)}`;
  }
  return undefined;
};

const matchesType = ({
  program,
  expected,
  actual,
  types,
}: {
  program: ProgramCodegenView;
  expected: CompilerContractTypeSpec;
  actual: TypeId;
  types: ContractTypes;
}): boolean => {
  if (expected.kind === "primitive")
    return actual === program.primitives[expected.name];
  if (expected.kind === "shared") {
    return sameContractType(
      program,
      actual,
      sharedTypeId(types, expected.name),
    );
  }
  const desc = program.types.getTypeDesc(actual);
  return (
    desc.kind === "fixed-array" &&
    matchesType({
      program,
      expected: expected.element,
      actual: desc.element,
      types,
    })
  );
};

const sharedTypeId = (
  types: ContractTypes,
  name: CompilerContractSharedType,
): TypeId => {
  const typeId = types[name];
  if (typeof typeId === "number") return typeId;
  throw new Error(`compiler contract shared type '${name}' is unavailable`);
};

const sameContractType = (
  program: ProgramCodegenView,
  left: TypeId,
  right: TypeId,
): boolean =>
  left === right ||
  program.types.unify(left, right, {
    location: 0 as NodeId,
    reason: "compiler function contract signature validation",
    variance: "invariant",
    allowUnknown: false,
  }).ok;

const formatExpectedSignature = (spec: CompilerFunctionContractSpec): string =>
  `(${spec.signature.parameters.map(({ type }) => formatExpectedType(type)).join(", ")}): pure -> ${formatExpectedType(spec.signature.result)}`;

const formatExpectedType = (type: CompilerContractTypeSpec): string => {
  if (type.kind === "primitive") return type.name;
  if (type.kind === "fixed-array")
    return `FixedArray<${formatExpectedType(type.element)}>`;
  return {
    msgpack: "MsgPack",
    string: "String",
    bytes: "Bytes",
    "msgpack-array": "Array<MsgPack>",
    "msgpack-map": "Map<String, MsgPack>",
    "msgpack-reader": "MsgPackReader",
    "msgpack-writer": "MsgPackWriter",
    data: "DataValue",
    "data-array": "Array<DataValue>",
    "data-map": "Map<String, DataValue>",
  }[type.name];
};

const formatActualSignature = (
  program: ProgramCodegenView,
  signature: CodegenFunctionSignature,
): string =>
  `${signature.typeParams.length > 0 ? `<${signature.typeParams.length} type parameter(s)>` : ""}(${signature.parameters.map(({ typeId, optional }) => `${formatType(program, typeId)}${optional ? "?" : ""}`).join(", ")}): ${program.effects.isEmpty(signature.effectRow) ? "pure" : "effectful"} -> ${formatType(program, signature.returnType)}`;

const formatType = (program: ProgramCodegenView, typeId: TypeId): string => {
  const desc: CodegenTypeDesc = program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") return desc.name;
  if (desc.kind === "fixed-array")
    return `FixedArray<${formatType(program, desc.element)}>`;
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return formatType(program, desc.nominal);
  }
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    const name = desc.name ?? program.symbols.getName(desc.owner) ?? desc.kind;
    return desc.typeArgs.length > 0
      ? `${name}<${desc.typeArgs.map((arg) => formatType(program, arg)).join(", ")}>`
      : name;
  }
  return `${desc.kind}#${typeId}`;
};
