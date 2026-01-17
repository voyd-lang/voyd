import type binaryen from "binaryen";
import type { GroupContinuationCfg } from "./continuation-cfg.js";
import type { EffectRegistry } from "./effect-registry.js";

export interface EffectsState {
  dispatcherName?: string;
  contBuilt: Set<string>;
  contBuilding: Set<string>;
  contCfgByName: Map<string, GroupContinuationCfg>;
  contRefTypeByKey: Map<string, binaryen.Type>;
  contSignatureByKey: Map<string, { returnType: number; envTypes: number[] }>;
  effectRegistry?: EffectRegistry;
  effectArgsTypes: Map<number, number>;
  closureCoercions: Map<
    string,
    { envType: number; fnName: string; fnRefType: number }
  >;
  memo: Map<symbol, unknown>;
}

export const createEffectsState = (): EffectsState => ({
  contBuilt: new Set<string>(),
  contBuilding: new Set<string>(),
  contCfgByName: new Map<string, GroupContinuationCfg>(),
  contRefTypeByKey: new Map<string, binaryen.Type>(),
  contSignatureByKey: new Map<string, { returnType: number; envTypes: number[] }>(),
  effectArgsTypes: new Map(),
  closureCoercions: new Map(),
  memo: new Map<symbol, unknown>(),
});
