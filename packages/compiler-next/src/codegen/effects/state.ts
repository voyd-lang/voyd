import type { GroupContinuationCfg } from "./continuation-cfg.js";

export interface EffectsState {
  dispatcherName?: string;
  contBuilt: Set<string>;
  contBuilding: Set<string>;
  contCfgByName: Map<string, GroupContinuationCfg>;
}

export const createEffectsState = (): EffectsState => ({
  contBuilt: new Set<string>(),
  contBuilding: new Set<string>(),
  contCfgByName: new Map<string, GroupContinuationCfg>(),
});
