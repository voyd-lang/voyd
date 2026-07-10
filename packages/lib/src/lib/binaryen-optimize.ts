import binaryen from "binaryen";

export type BinaryenOptimizationProfile = "aggressive" | "standard";

export const AGGRESSIVE_BINARYEN_EXTRA_PASSES = [
  "const-hoisting",
  "heap-store-optimization",
  "heap2local",
  "licm",
  "merge-locals",
  "merge-similar-functions",
  "optimize-casts",
  "precompute-propagate",
  "tuple-optimization",
] as const;

export type AggressiveBinaryenExtraPass =
  (typeof AGGRESSIVE_BINARYEN_EXTRA_PASSES)[number];

type BinaryenOptimizationExperiment = {
  disabledExtraPasses?: readonly AggressiveBinaryenExtraPass[];
  skipFinalOptimize?: boolean;
};

export type BinaryenOptimizationReport = {
  profile: BinaryenOptimizationProfile;
  extraPasses: readonly AggressiveBinaryenExtraPass[];
  phasesMs: {
    initialOptimize: number;
    extraPasses: number;
    finalOptimize: number;
  };
};

export const optimizeBinaryenModule = ({
  module,
  profile,
}: {
  module: binaryen.Module;
  profile: BinaryenOptimizationProfile;
}): BinaryenOptimizationReport => {
  const previousOptimizeLevel = binaryen.getOptimizeLevel();
  const previousShrinkLevel = binaryen.getShrinkLevel();
  const optimizeLevel = profile === "aggressive" ? 3 : 2;
  const shrinkLevel = profile === "aggressive" ? 2 : 1;

  const experiment = readBinaryenOptimizationExperiment();
  const disabledExtraPasses = new Set(experiment?.disabledExtraPasses ?? []);
  if (
    profile !== "aggressive" &&
    (disabledExtraPasses.size > 0 || experiment?.skipFinalOptimize)
  ) {
    throw new Error(
      "Binaryen ablation experiments require the aggressive profile",
    );
  }
  const extraPasses =
    profile === "aggressive"
      ? AGGRESSIVE_BINARYEN_EXTRA_PASSES.filter(
          (pass) => !disabledExtraPasses.has(pass),
        )
      : [];
  const phasesMs = {
    initialOptimize: 0,
    extraPasses: 0,
    finalOptimize: 0,
  };

  binaryen.setOptimizeLevel(optimizeLevel);
  binaryen.setShrinkLevel(shrinkLevel);

  try {
    let startedAt = performance.now();
    module.optimize();
    phasesMs.initialOptimize = performance.now() - startedAt;
    if (profile === "aggressive") {
      if (extraPasses.length > 0) {
        startedAt = performance.now();
        module.runPasses([...extraPasses]);
        phasesMs.extraPasses = performance.now() - startedAt;
      }
      if (!experiment?.skipFinalOptimize) {
        startedAt = performance.now();
        module.optimize();
        phasesMs.finalOptimize = performance.now() - startedAt;
      }
    }
  } finally {
    binaryen.setOptimizeLevel(previousOptimizeLevel);
    binaryen.setShrinkLevel(previousShrinkLevel);
  }
  return { profile, extraPasses, phasesMs };
};

const ENABLE_ABLATION_ENV = "VOYD_INTERNAL_BINARYEN_ABLATION";
const ABLATION_EXPERIMENT_ENV = "VOYD_BINARYEN_EXPERIMENT";

const readBinaryenOptimizationExperiment = ():
  | BinaryenOptimizationExperiment
  | undefined => {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  if (env?.[ENABLE_ABLATION_ENV] !== "1") {
    return undefined;
  }
  const raw = env[ABLATION_EXPERIMENT_ENV];
  if (!raw) {
    throw new Error(
      `${ABLATION_EXPERIMENT_ENV} is required when ${ENABLE_ABLATION_ENV}=1`,
    );
  }
  const parsed = JSON.parse(raw) as {
    disabledExtraPasses?: unknown;
    skipFinalOptimize?: unknown;
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${ABLATION_EXPERIMENT_ENV} must contain a JSON object`);
  }
  const disabled = parsed.disabledExtraPasses ?? [];
  if (
    !Array.isArray(disabled) ||
    disabled.some(
      (pass) =>
        typeof pass !== "string" ||
        !AGGRESSIVE_BINARYEN_EXTRA_PASSES.includes(
          pass as AggressiveBinaryenExtraPass,
        ),
    )
  ) {
    throw new Error(
      `${ABLATION_EXPERIMENT_ENV} contains an unknown Binaryen pass`,
    );
  }
  if (
    parsed.skipFinalOptimize !== undefined &&
    typeof parsed.skipFinalOptimize !== "boolean"
  ) {
    throw new Error(
      `${ABLATION_EXPERIMENT_ENV}.skipFinalOptimize must be boolean`,
    );
  }
  return {
    disabledExtraPasses: disabled as AggressiveBinaryenExtraPass[],
    skipFinalOptimize: parsed.skipFinalOptimize as boolean | undefined,
  };
};
