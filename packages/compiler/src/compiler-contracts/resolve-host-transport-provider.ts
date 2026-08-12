import type {
  CodegenTraitImplInstance,
  CodegenFunctionSignature,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import type { NodeId, ProgramSymbolId, TypeId } from "../semantics/ids.js";
import {
  HOST_TRANSPORT_PROVIDER_CONTRACT,
  HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
  type CompilerTraitMethodRole,
} from "./trait-contracts.js";
import { SELECTED_HOST_TRANSPORT_IMPLEMENTATION } from "./selected-host-transport.js";

export type ResolvedHostTransportProvider = {
  identity: { id: string; version: number };
  implementation: CodegenTraitImplInstance;
  readerTypeId: TypeId;
  writerTypeId: TypeId;
  functions: Readonly<Record<CompilerTraitMethodRole, ProgramSymbolId>>;
  readerImplementation: CodegenTraitImplInstance;
  writerImplementation: CodegenTraitImplInstance;
};

export const resolveSelectedHostTransportProvider = (
  program: ProgramCodegenView,
): ResolvedHostTransportProvider => {
  const traitSymbol = program.symbols.resolveCompilerTraitContract(
    HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
  );
  if (traitSymbol === undefined) {
    throw new Error(
      `missing compiler trait contract '${HOST_TRANSPORT_PROVIDER_CONTRACT_ID}'`,
    );
  }

  const selected = program.traits
    .getImplsByTrait(traitSymbol)
    .filter((implementation) => {
      const declaration = program.symbols.getCompilerImplementation(
        implementation.implSymbol,
      );
      return (
        declaration?.id === SELECTED_HOST_TRANSPORT_IMPLEMENTATION.id &&
        declaration.version === SELECTED_HOST_TRANSPORT_IMPLEMENTATION.version
      );
    });
  if (selected.length !== 1) {
    const identity = `${SELECTED_HOST_TRANSPORT_IMPLEMENTATION.id}@${SELECTED_HOST_TRANSPORT_IMPLEMENTATION.version}`;
    throw new Error(
      selected.length === 0
        ? `missing @compiler_impl(id: "${SELECTED_HOST_TRANSPORT_IMPLEMENTATION.id}", version: ${SELECTED_HOST_TRANSPORT_IMPLEMENTATION.version}) for compiler trait contract '${HOST_TRANSPORT_PROVIDER_CONTRACT_ID}'`
        : `duplicate @compiler_impl registration for ${identity} and compiler trait contract '${HOST_TRANSPORT_PROVIDER_CONTRACT_ID}'`,
    );
  }

  const implementation = selected[0]!;
  if (
    program.symbols.getPackageId(implementation.implSymbol) !==
    SELECTED_HOST_TRANSPORT_IMPLEMENTATION.packageId
  ) {
    throw new Error(
      "the selected host transport implementation is not a registered link root",
    );
  }
  validateStatelessTarget(program, implementation);

  const trait = program.types.getTypeDesc(implementation.trait);
  if (trait.kind !== "trait" || trait.typeArgs.length !== 2) {
    throw new Error(
      "HostTransportProvider must declare Reader and Writer type arguments",
    );
  }
  const readerTypeId = trait.typeArgs[0]!;
  const writerTypeId = trait.typeArgs[1]!;
  const functions = resolveProviderFunctions({
    program,
    implementation,
    readerTypeId,
    writerTypeId,
  });

  return {
    identity: {
      id: SELECTED_HOST_TRANSPORT_IMPLEMENTATION.id,
      version: SELECTED_HOST_TRANSPORT_IMPLEMENTATION.version,
    },
    implementation,
    readerTypeId,
    writerTypeId,
    functions,
    readerImplementation: requireDataImplementation({
      program,
      typeId: readerTypeId,
      traitName: "DataReader",
    }),
    writerImplementation: requireDataImplementation({
      program,
      typeId: writerTypeId,
      traitName: "DataWriter",
    }),
  };
};

const validateStatelessTarget = (
  program: ProgramCodegenView,
  implementation: CodegenTraitImplInstance,
): void => {
  const owner = program.types.getNominalOwner(implementation.target);
  const template =
    owner === undefined ? undefined : program.objects.getTemplate(owner);
  if (
    !template ||
    template.fields.length !== 0 ||
    template.params.length !== 0
  ) {
    throw new Error(
      "the selected HostTransportProvider implementation must target a stateless object",
    );
  }
};

const resolveProviderFunctions = ({
  program,
  implementation,
  readerTypeId,
  writerTypeId,
}: {
  program: ProgramCodegenView;
  implementation: CodegenTraitImplInstance;
  readerTypeId: TypeId;
  writerTypeId: TypeId;
}): Readonly<Record<CompilerTraitMethodRole, ProgramSymbolId>> => {
  const methods = new Map(
    implementation.staticMethods.map(({ traitMethod, implMethod }) => [
      program.symbols.getCompilerTraitMethodRole(traitMethod),
      implMethod,
    ]),
  );
  if (methods.size !== HOST_TRANSPORT_PROVIDER_CONTRACT.methods.length) {
    throw new Error(
      "the selected HostTransportProvider implementation has an incomplete static method mapping",
    );
  }

  const result = {} as Record<CompilerTraitMethodRole, ProgramSymbolId>;
  HOST_TRANSPORT_PROVIDER_CONTRACT.methods.forEach((method) => {
    const symbol = methods.get(method.role);
    if (symbol === undefined) {
      throw new Error(
        `the selected HostTransportProvider implementation is missing '${method.name}'`,
      );
    }
    const expected = expectedSignature({
      role: method.role,
      program,
      readerTypeId,
      writerTypeId,
    });
    validateMethodSignature({
      program,
      methodName: method.name,
      symbol,
      expectedParameters: expected.parameters,
      expectedResult: expected.result,
    });
    result[method.role] = symbol;
  });
  return result;
};

const expectedSignature = ({
  role,
  program,
  readerTypeId,
  writerTypeId,
}: {
  role: CompilerTraitMethodRole;
  program: ProgramCodegenView;
  readerTypeId: TypeId;
  writerTypeId: TypeId;
}): { parameters: readonly TypeId[]; result: TypeId } => {
  switch (role) {
    case "createReader":
      return {
        parameters: [program.primitives.i32, program.primitives.i32],
        result: readerTypeId,
      };
    case "readerComplete":
      return { parameters: [readerTypeId], result: program.primitives.bool };
    case "createWriter":
      return {
        parameters: [program.primitives.i32, program.primitives.i32],
        result: writerTypeId,
      };
    case "finishWriter":
      return { parameters: [writerTypeId], result: program.primitives.i32 };
  }
};

const validateMethodSignature = ({
  program,
  methodName,
  symbol,
  expectedParameters,
  expectedResult,
}: {
  program: ProgramCodegenView;
  methodName: string;
  symbol: ProgramSymbolId;
  expectedParameters: readonly TypeId[];
  expectedResult: TypeId;
}): void => {
  const ref = program.symbols.refOf(symbol);
  const signature = program.functions.getSignature(ref.moduleId, ref.symbol);
  const mismatch = signature
    ? signatureMismatch({
        program,
        signature,
        expectedParameters,
        expectedResult,
      })
    : "has no typed signature";
  if (mismatch) {
    throw new Error(`HostTransportProvider method '${methodName}' ${mismatch}`);
  }
};

const signatureMismatch = ({
  program,
  signature,
  expectedParameters,
  expectedResult,
}: {
  program: ProgramCodegenView;
  signature: CodegenFunctionSignature;
  expectedParameters: readonly TypeId[];
  expectedResult: TypeId;
}): string | undefined => {
  if (signature.typeParams.length !== 0) return "must not be generic";
  if (signature.parameters.length !== expectedParameters.length) {
    return `expects ${expectedParameters.length} parameter(s), but declares ${signature.parameters.length}`;
  }
  const optional = signature.parameters.findIndex(
    (parameter) => parameter.optional,
  );
  if (optional >= 0) return `parameter ${optional + 1} must not be optional`;
  if (!program.effects.isEmpty(signature.effectRow)) return "must be pure";
  const parameterMismatch = signature.parameters.findIndex(
    (parameter, index) =>
      !sameType(program, parameter.typeId, expectedParameters[index]!),
  );
  if (parameterMismatch >= 0) {
    return `parameter ${parameterMismatch + 1} has the wrong type`;
  }
  if (!sameType(program, signature.returnType, expectedResult)) {
    return "has the wrong result type";
  }
  return undefined;
};

const sameType = (
  program: ProgramCodegenView,
  left: TypeId,
  right: TypeId,
): boolean =>
  left === right ||
  program.types.unify(left, right, {
    location: 0 as NodeId,
    reason: "host transport provider contract validation",
    variance: "invariant",
    allowUnknown: false,
  }).ok;

const requireDataImplementation = ({
  program,
  typeId,
  traitName,
}: {
  program: ProgramCodegenView;
  typeId: TypeId;
  traitName: "DataReader" | "DataWriter";
}): CodegenTraitImplInstance => {
  const desc = program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "intersection" && desc.nominal !== undefined
      ? desc.nominal
      : (program.types.getNominalOwner(typeId) ?? typeId);
  const matches = program.traits
    .getImplsByNominal(nominal)
    .filter((candidate) => {
      const ref = program.symbols.refOf(candidate.traitSymbol);
      return (
        ref.moduleId === "std::data" &&
        program.symbols.getName(candidate.traitSymbol) === traitName
      );
    });
  if (matches.length !== 1) {
    throw new Error(
      `the selected host transport requires exactly one std::data::${traitName} implementation for type ${typeId}`,
    );
  }
  return matches[0]!;
};
