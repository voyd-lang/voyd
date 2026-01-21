import type { CodegenContext } from "./context.js";
import { emitDispatcher } from "./effects/dispatcher.js";
import { addEffectRuntimeHelpers } from "./effects/runtime-helpers.js";

export type ProgramHelperRegistry = {
  ensureDispatcher: (ctx: CodegenContext) => string;
  ensureEffectHelpers: (ctx: CodegenContext) => void;
  registerExportName: (name: string) => boolean;
  recordHelper: (name: string) => void;
  hasHelper: (name: string) => boolean;
  getHelperState: <T>(key: symbol, init: () => T) => T;
};

export const createProgramHelperRegistry = (): ProgramHelperRegistry => {
  const helpers = new Set<string>();
  const exports = new Set<string>();
  const helperState = new Map<symbol, unknown>();
  let dispatcherName: string | undefined;
  let effectHelpersReady = false;

  const registerExportName = (name: string): boolean => {
    if (exports.has(name)) {
      return false;
    }
    exports.add(name);
    return true;
  };

  const recordHelper = (name: string): void => {
    helpers.add(name);
  };

  const hasHelper = (name: string): boolean => helpers.has(name);

  const getHelperState = <T>(key: symbol, init: () => T): T => {
    if (helperState.has(key)) {
      return helperState.get(key) as T;
    }
    const created = init();
    helperState.set(key, created);
    return created;
  };

  const ensureDispatcher = (ctx: CodegenContext): string => {
    if (dispatcherName) {
      return dispatcherName;
    }
    if (helpers.has("__voyd_dispatch")) {
      dispatcherName = "__voyd_dispatch";
      ctx.effectsState.dispatcherName = dispatcherName;
      return dispatcherName;
    }
    const created = emitDispatcher(ctx);
    dispatcherName = created;
    recordHelper(created);
    ctx.effectsState.dispatcherName = created;
    return created;
  };

  const ensureEffectHelpers = (ctx: CodegenContext): void => {
    if (effectHelpersReady) {
      return;
    }
    addEffectRuntimeHelpers(ctx);
    effectHelpersReady = true;
  };

  return {
    ensureDispatcher,
    ensureEffectHelpers,
    registerExportName,
    recordHelper,
    hasHelper,
    getHelperState,
  };
};
