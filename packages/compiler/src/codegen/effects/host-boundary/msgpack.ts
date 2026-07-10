import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { ProgramSymbolId, TypeId } from "../../../semantics/ids.js";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  validateBoundaryMsgpackFunctionContracts,
  type CompilerFunctionContractId,
} from "../../../compiler-contracts/index.js";
import { requireFunctionMetaByCompilerContract } from "../../function-lookup.js";
import { stateFor } from "./state.js";

export type MsgPackFunctions = {
  msgPackTypeId: TypeId;
  encodeValue: FunctionMetadata;
  decodeValue: FunctionMetadata;
  makeNull: FunctionMetadata;
  makeBool: FunctionMetadata;
  makeString: FunctionMetadata;
  makeArray: FunctionMetadata;
  makeI32: FunctionMetadata;
  makeI64: FunctionMetadata;
  makeF32: FunctionMetadata;
  makeF64: FunctionMetadata;
  makeMap: FunctionMetadata;
  unpackBool: FunctionMetadata;
  unpackString: FunctionMetadata;
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

const MSGPACK_FUNCS_KEY = Symbol("voyd.effects.hostBoundary.msgpackFunctions");
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

export const ensureMsgPackFunctions = (
  ctx: CodegenContext
): MsgPackFunctions =>
  stateFor(ctx, MSGPACK_FUNCS_KEY, () => {
    const { msgpack: msgPackTypeId } =
      validateBoundaryMsgpackFunctionContracts(ctx.program);
    const functions = {
      encodeValue: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.encodeValue,
      ),
      decodeValue: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.decodeValue,
      ),
      makeNull: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull),
      makeBool: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeBool),
      makeString: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.makeString,
      ),
      makeArray: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeArray),
      makeI32: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeI32),
      makeI64: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeI64),
      makeF32: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeF32),
      makeF64: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeF64),
      makeMap: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.makeMap),
      unpackBool: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.unpackBool,
      ),
      unpackString: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.unpackString,
      ),
      unpackArray: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.unpackArray,
      ),
      unpackI32: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.unpackI32),
      unpackI64: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.unpackI64),
      unpackF32: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.unpackF32),
      unpackF64: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.unpackF64),
      unpackMap: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.unpackMap),
      arrayWithCapacity: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.arrayWithCapacity,
      ),
      arrayPush: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.arrayPush),
      arrayLength: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.arrayLength,
      ),
      arrayRawStorage: requireContract(
        ctx,
        BOUNDARY_MSGPACK_CONTRACT_IDS.arrayRawStorage,
      ),
      mapNew: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.mapNew),
      mapSet: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.mapSet),
      mapGet: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.mapGet),
      mapHas: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.mapHas),
      mapTagIs: requireContract(ctx, BOUNDARY_MSGPACK_CONTRACT_IDS.mapTagIs),
    };
    const msgpack: MsgPackFunctions = {
      msgPackTypeId,
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
      BOUNDARY_MSGPACK_CONTRACT_IDS.newString,
    );
    markReachable({
      ctx,
      moduleId: stringNew.moduleId,
      symbol: stringNew.symbol,
    });

    return msgpack;
  });
