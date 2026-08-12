import {
  DTO_DATA_CONTRACT_IDS,
  validateDtoDataFunctionContracts,
} from "../../compiler-contracts/index.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import type { CodegenContext, FunctionMetadata } from "../context.js";
import { requireFunctionMetaByCompilerContract } from "../function-lookup.js";
import { stateFor } from "../effects/host-boundary/state.js";
import type { DtoTreeProvider } from "./dto-tree-codec.js";

const FUNCTIONS_KEY = Symbol("voyd.dto.dataValueFunctions");
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = { symbols?: Set<ProgramSymbolId> };

export const ensureDataValueFunctions = (
  ctx: CodegenContext,
): DtoTreeProvider =>
  stateFor(ctx, FUNCTIONS_KEY, () => {
    const { data: dataTypeId } = validateDtoDataFunctionContracts(ctx.program);
    const requireContract = (
      id: (typeof DTO_DATA_CONTRACT_IDS)[keyof typeof DTO_DATA_CONTRACT_IDS],
    ): FunctionMetadata =>
      requireFunctionMetaByCompilerContract({ ctx, contractId: id });
    const functions = {
      cycleError: requireContract(DTO_DATA_CONTRACT_IDS.cycleError),
      makeNull: requireContract(DTO_DATA_CONTRACT_IDS.makeNull),
      makeBool: requireContract(DTO_DATA_CONTRACT_IDS.makeBool),
      makeString: requireContract(DTO_DATA_CONTRACT_IDS.makeString),
      makeBytes: requireContract(DTO_DATA_CONTRACT_IDS.makeBytes),
      makeArray: requireContract(DTO_DATA_CONTRACT_IDS.makeArray),
      makeI32: requireContract(DTO_DATA_CONTRACT_IDS.makeI32),
      makeI64: requireContract(DTO_DATA_CONTRACT_IDS.makeI64),
      makeF32: requireContract(DTO_DATA_CONTRACT_IDS.makeF32),
      makeF64: requireContract(DTO_DATA_CONTRACT_IDS.makeF64),
      makeMap: requireContract(DTO_DATA_CONTRACT_IDS.makeMap),
      unpackBool: requireContract(DTO_DATA_CONTRACT_IDS.unpackBool),
      unpackString: requireContract(DTO_DATA_CONTRACT_IDS.unpackString),
      unpackBytes: requireContract(DTO_DATA_CONTRACT_IDS.unpackBytes),
      unpackArray: requireContract(DTO_DATA_CONTRACT_IDS.unpackArray),
      unpackI32: requireContract(DTO_DATA_CONTRACT_IDS.unpackI32),
      unpackI64: requireContract(DTO_DATA_CONTRACT_IDS.unpackI64),
      unpackF32: requireContract(DTO_DATA_CONTRACT_IDS.unpackF32),
      unpackF64: requireContract(DTO_DATA_CONTRACT_IDS.unpackF64),
      unpackMap: requireContract(DTO_DATA_CONTRACT_IDS.unpackMap),
      arrayWithCapacity: requireContract(DTO_DATA_CONTRACT_IDS.arrayWithCapacity),
      arrayPush: requireContract(DTO_DATA_CONTRACT_IDS.arrayPush),
      arrayLength: requireContract(DTO_DATA_CONTRACT_IDS.arrayLength),
      arrayRawStorage: requireContract(DTO_DATA_CONTRACT_IDS.arrayRawStorage),
      mapNew: requireContract(DTO_DATA_CONTRACT_IDS.mapNew),
      mapSet: requireContract(DTO_DATA_CONTRACT_IDS.mapSet),
      mapGet: requireContract(DTO_DATA_CONTRACT_IDS.mapGet),
      mapHas: requireContract(DTO_DATA_CONTRACT_IDS.mapHas),
      mapTagIs: requireContract(DTO_DATA_CONTRACT_IDS.mapTagIs),
      newString: requireContract(DTO_DATA_CONTRACT_IDS.newString),
    };
    const state = ctx.programHelpers.getHelperState<ReachabilityState>(
      REACHABILITY_STATE,
      () => ({ symbols: new Set<ProgramSymbolId>() }),
    );
    const symbols = state.symbols ?? new Set<ProgramSymbolId>();
    state.symbols = symbols;
    Object.values(functions).forEach((meta) =>
      symbols.add(
        ctx.program.symbols.canonicalIdOf(
          meta.moduleId,
          meta.symbol,
        ) as ProgramSymbolId,
      ),
    );
    return {
      valueTypeId: dataTypeId,
      ...functions,
    };
  });
