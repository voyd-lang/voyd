import { runBrowserCompilerBundleSmoke } from "./browser-bundle-entry.js";
import { runBrowserVsxBundleSmoke } from "./browser-bundle-vsx-entry.js";

type KitchenSinkResult = {
  compilerSize: number;
  vsxSize: number;
};

export const runBrowserKitchenSinkSmoke = async (): Promise<KitchenSinkResult> => {
  const compilerSize = await runBrowserCompilerBundleSmoke();
  const vsxSize = await runBrowserVsxBundleSmoke();
  return { compilerSize, vsxSize };
};
