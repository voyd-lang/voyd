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

export const optimizeBinaryenModule = ({
  module,
  profile,
}: {
  module: binaryen.Module;
  profile: BinaryenOptimizationProfile;
}): void => {
  const previousOptimizeLevel = binaryen.getOptimizeLevel();
  const previousShrinkLevel = binaryen.getShrinkLevel();
  const optimizeLevel = profile === "aggressive" ? 3 : 2;
  const shrinkLevel = profile === "aggressive" ? 2 : 1;

  binaryen.setOptimizeLevel(optimizeLevel);
  binaryen.setShrinkLevel(shrinkLevel);

  try {
    module.optimize();
    if (profile === "aggressive") {
      module.runPasses([...AGGRESSIVE_BINARYEN_EXTRA_PASSES]);
      module.optimize();
    }
  } finally {
    binaryen.setOptimizeLevel(previousOptimizeLevel);
    binaryen.setShrinkLevel(previousShrinkLevel);
  }
};
