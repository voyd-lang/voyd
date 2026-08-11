import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { ProgramSymbolId, TypeId } from "../../../semantics/ids.js";
import {
  MSGPACK_HOST_TRANSPORT_CONTRACT_IDS,
  validateMsgpackHostTransportFunctionContracts,
  type CompilerFunctionContractId,
} from "../../../compiler-contracts/index.js";
import { requireFunctionMetaByCompilerContract } from "../../function-lookup.js";
import { stateFor } from "../../effects/host-boundary/state.js";
import type {
  HostTransportProviderDescriptor,
  HostTransportProviderFunctions,
} from "../provider.js";

export const MSGPACK_HOST_TRANSPORT_IDENTITY = {
  id: "voyd.std.msgpack",
  version: 1,
} as const;

const MSGPACK_PROVIDER_FUNCS_KEY = Symbol(
  "voyd.hostTransport.msgpackProviderFunctions",
);
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

export const enqueueMsgPackProviderReachability = ({
  ctx,
  enqueue,
}: {
  ctx: CodegenContext;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  Object.values(MSGPACK_HOST_TRANSPORT_CONTRACT_IDS).forEach((contractId) => {
    const symbol =
      ctx.program.symbols.resolveCompilerFunctionContract(contractId);
    if (typeof symbol === "number") enqueue(symbol);
  });
  enqueueTraitImplementation({
    ctx,
    typeId: contractResultType({
      ctx,
      contractId: MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createReader,
    }),
    traitName: "DataReader",
    enqueue,
  });
  enqueueTraitImplementation({
    ctx,
    typeId: contractResultType({
      ctx,
      contractId: MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createWriter,
    }),
    traitName: "DataWriter",
    enqueue,
  });
};

const contractResultType = ({
  ctx,
  contractId,
}: {
  ctx: CodegenContext;
  contractId: CompilerFunctionContractId;
}): TypeId => {
  const symbol = ctx.program.symbols.resolveCompilerFunctionContract(contractId);
  if (typeof symbol !== "number") {
    throw new Error(`missing compiler function contract '${contractId}'`);
  }
  const ref = ctx.program.symbols.refOf(symbol);
  const typeId = ctx.program.functions.getSignature(
    ref.moduleId,
    ref.symbol,
  )?.returnType;
  if (typeof typeId !== "number") {
    throw new Error(
      `compiler function contract '${contractId}' has no result type`,
    );
  }
  return typeId;
};

const enqueueTraitImplementation = ({
  ctx,
  typeId,
  traitName,
  enqueue,
}: {
  ctx: CodegenContext;
  typeId: TypeId;
  traitName: string;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  const impl = requireTraitImplementation({ ctx, typeId, traitName });
  impl.methods.forEach(({ implMethod }) => enqueue(implMethod));
};

const requireTraitImplementation = ({
  ctx,
  typeId,
  traitName,
}: {
  ctx: CodegenContext;
  typeId: TypeId;
  traitName: string;
}) => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "intersection" && desc.nominal !== undefined
      ? desc.nominal
      : (ctx.program.types.getNominalOwner(typeId) ?? typeId);
  const impl = ctx.program.traits
    .getImplsByNominal(nominal)
    .find(
      (candidate) =>
        ctx.program.symbols.getName(candidate.traitSymbol) === traitName,
    );
  if (!impl) {
    throw new Error(
      `MessagePack host transport requires ${traitName} for type ${typeId}`,
    );
  }
  return impl;
};

const markReachable = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: ProgramSymbolId;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const symbols = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = symbols;
  symbols.add(symbol);
};

const requireContract = (
  ctx: CodegenContext,
  contractId: CompilerFunctionContractId,
): FunctionMetadata =>
  requireFunctionMetaByCompilerContract({ ctx, contractId });

const markTraitImplementationReachable = ({
  ctx,
  typeId,
  traitName,
}: {
  ctx: CodegenContext;
  typeId: TypeId;
  traitName: string;
}): void => {
  requireTraitImplementation({ ctx, typeId, traitName }).methods.forEach(
    ({ implMethod }) => {
      const ref = ctx.program.symbols.refOf(implMethod);
      markReachable({
        ctx,
        symbol: ctx.program.symbols.canonicalIdOf(
          ref.moduleId,
          ref.symbol,
        ) as ProgramSymbolId,
      });
    },
  );
};

export const ensureMsgPackProviderFunctions = (
  ctx: CodegenContext,
): HostTransportProviderFunctions =>
  stateFor(ctx, MSGPACK_PROVIDER_FUNCS_KEY, () => {
    const { reader: readerTypeId, writer: writerTypeId } =
      validateMsgpackHostTransportFunctionContracts(ctx.program);
    const functions = {
      createReader: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createReader,
      ),
      readerComplete: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.readerComplete,
      ),
      createWriter: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createWriter,
      ),
      finishWriter: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.finishWriter,
      ),
    };
    Object.values(functions).forEach((meta) =>
      markReachable({
        ctx,
        symbol: ctx.program.symbols.canonicalIdOf(
          meta.moduleId,
          meta.symbol,
        ) as ProgramSymbolId,
      }),
    );
    markTraitImplementationReachable({
      ctx,
      typeId: readerTypeId,
      traitName: "DataReader",
    });
    markTraitImplementationReachable({
      ctx,
      typeId: writerTypeId,
      traitName: "DataWriter",
    });
    return { readerTypeId, writerTypeId, ...functions };
  });

export const MSGPACK_HOST_TRANSPORT_PROVIDER: HostTransportProviderDescriptor = {
  identity: MSGPACK_HOST_TRANSPORT_IDENTITY,
  ensureFunctions: ensureMsgPackProviderFunctions,
  enqueueReachability: enqueueMsgPackProviderReachability,
};
