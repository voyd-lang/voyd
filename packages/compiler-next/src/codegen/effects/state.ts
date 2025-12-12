export interface EffectsState {
  dispatcherName?: string;
  contBuilt: Set<number>;
  contBuilding: Set<number>;
}

export const createEffectsState = (): EffectsState => ({
  contBuilt: new Set<number>(),
  contBuilding: new Set<number>(),
});

