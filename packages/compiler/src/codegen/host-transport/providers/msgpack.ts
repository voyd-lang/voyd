import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { ProgramSymbolId, TypeId } from "../../../semantics/ids.js";
import {
  MSGPACK_HOST_TRANSPORT_CONTRACT_IDS,
  validateMsgpackHostTransportFunctionContracts,
  type CompilerFunctionContractId,
} from "../../../compiler-contracts/index.js";
import { requireFunctionMetaByCompilerContract } from "../../function-lookup.js";
import { stateFor } from "../../effects/host-boundary/state.js";

export type MsgPackProviderFunctions = {
  valueTypeId: TypeId;
  encodeValue: FunctionMetadata;
  decodeValue: FunctionMetadata;
  makeNull: FunctionMetadata;
  makeBool: FunctionMetadata;
  makeString: FunctionMetadata;
  makeBytes: FunctionMetadata;
  makeArray: FunctionMetadata;
  makeI32: FunctionMetadata;
  makeI64: FunctionMetadata;
  makeF32: FunctionMetadata;
  makeF64: FunctionMetadata;
  makeMap: FunctionMetadata;
  unpackBool: FunctionMetadata;
  unpackString: FunctionMetadata;
  unpackBytes: FunctionMetadata;
  unpackArray: FunctionMetadata;
  unpackI32: FunctionMetadata;
  unpackI64: FunctionMetadata;
  unpackF32: FunctionMetadata;
  unpackF64: FunctionMetadata;
  unpackMap: FunctionMetadata;
  arrayWithCapacity: FunctionMetadata;
  arrayPush: FunctionMetadata;
  arrayLength: FunctionMetadata;
  arrayRawStorage: FunctionMetadata;
  mapNew: FunctionMetadata;
  mapSet: FunctionMetadata;
  mapGet: FunctionMetadata;
  mapHas: FunctionMetadata;
  mapTagIs: FunctionMetadata;
};

const MSGPACK_PROVIDER_FUNCS_KEY = Symbol(
  "voyd.hostTransport.msgpackProviderFunctions",
);
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

const markReachable = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: number;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const symbols = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = symbols;
  symbols.add(
    ctx.program.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId,
  );
};

const requireContract = (
  ctx: CodegenContext,
  contractId: CompilerFunctionContractId,
): FunctionMetadata =>
  requireFunctionMetaByCompilerContract({ ctx, contractId });

export const ensureMsgPackProviderFunctions = (
  ctx: CodegenContext,
): MsgPackProviderFunctions =>
  stateFor(ctx, MSGPACK_PROVIDER_FUNCS_KEY, () => {
    const { msgpack: valueTypeId } =
      validateMsgpackHostTransportFunctionContracts(ctx.program);
    const functions = {
      encodeValue: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.encodeValue,
      ),
      decodeValue: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.decodeValue,
      ),
      makeNull: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeNull,
      ),
      makeBool: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeBool,
      ),
      makeString: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeString,
      ),
      makeBytes: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeBytes,
      ),
      makeArray: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeArray,
      ),
      makeI32: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeI32,
      ),
      makeI64: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeI64,
      ),
      makeF32: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeF32,
      ),
      makeF64: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeF64,
      ),
      makeMap: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.makeMap,
      ),
      unpackBool: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackBool,
      ),
      unpackString: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackString,
      ),
      unpackBytes: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackBytes,
      ),
      unpackArray: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackArray,
      ),
      unpackI32: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackI32,
      ),
      unpackI64: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackI64,
      ),
      unpackF32: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackF32,
      ),
      unpackF64: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackF64,
      ),
      unpackMap: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.unpackMap,
      ),
      arrayWithCapacity: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.arrayWithCapacity,
      ),
      arrayPush: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.arrayPush,
      ),
      arrayLength: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.arrayLength,
      ),
      arrayRawStorage: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.arrayRawStorage,
      ),
      mapNew: requireContract(ctx, MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.mapNew),
      mapSet: requireContract(ctx, MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.mapSet),
      mapGet: requireContract(ctx, MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.mapGet),
      mapHas: requireContract(ctx, MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.mapHas),
      mapTagIs: requireContract(
        ctx,
        MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.mapTagIs,
      ),
    };
    const msgpack: MsgPackProviderFunctions = {
      valueTypeId,
      ...functions,
    };

    Object.values(functions).forEach((meta) =>
      markReachable({
        ctx,
        moduleId: meta.moduleId,
        symbol: meta.symbol,
      }),
    );
    const stringNew = requireContract(
      ctx,
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.newString,
    );
    markReachable({
      ctx,
      moduleId: stringNew.moduleId,
      symbol: stringNew.symbol,
    });

    return msgpack;
  });
