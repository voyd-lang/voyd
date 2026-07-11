import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConformanceCompilerAdapter } from "./compiler-adapter.js";
import { createCurrentCompilerAdapter } from "./current-compiler-adapter.js";

type AdapterModule = {
  createConformanceCompilerAdapter?: () => ConformanceCompilerAdapter;
};

/**
 * VOYD_CONFORMANCE_ADAPTER may name a JS module exporting
 * createConformanceCompilerAdapter. This keeps the corpus independent of the
 * current compiler while retaining a zero-configuration in-repo default.
 */
export const loadCompilerAdapter =
  async (): Promise<ConformanceCompilerAdapter> => {
    const modulePath = process.env.VOYD_CONFORMANCE_ADAPTER;
    if (!modulePath) {
      return createCurrentCompilerAdapter();
    }

    const module = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as AdapterModule;
    if (typeof module.createConformanceCompilerAdapter !== "function") {
      throw new Error(
        `${modulePath} must export createConformanceCompilerAdapter()`,
      );
    }
    return module.createConformanceCompilerAdapter();
  };
