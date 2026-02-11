export { buildEffectLoweringEir } from "./effect-lowering/build.js";
export { materializeGcTrampolineEffectLowering } from "./effect-lowering/gc-trampoline-materialize.js";
export type {
  BuildEffectLoweringParams,
  ContinuationCaptureField,
  ContinuationCallSite,
  ContinuationEnvField,
  ContinuationFieldSource,
  ContinuationCaptureSource,
  ContinuationCallSiteEir,
  ContinuationPerformSite,
  ContinuationPerformSiteEir,
  ContinuationSite,
  ContinuationSiteEir,
  ContinuationSiteBase,
  ContinuationSiteEirBase,
  ContinuationSiteOwner,
  EffectLoweringEirResult,
  EffectLoweringResult,
  SiteCounter,
} from "./effect-lowering/types.js";
