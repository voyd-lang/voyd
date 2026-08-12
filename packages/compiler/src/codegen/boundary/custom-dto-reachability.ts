import type binaryen from "binaryen";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";

const reachableByModule = new WeakMap<object, Set<string>>();

export const markCustomDtoFunctionReachable = ({
  mod,
  program,
  functionId,
}: {
  mod: binaryen.Module;
  program: ProgramCodegenView;
  functionId: ProgramSymbolId;
}): void => {
  const ref = program.symbols.refOf(functionId);
  const reachable = reachableByModule.get(mod) ?? new Set<string>();
  reachable.add(keyOf(ref.moduleId, ref.symbol));
  reachableByModule.set(mod, reachable);
};

export const isCustomDtoFunctionReachable = ({
  mod,
  moduleId,
  symbol,
}: {
  mod: binaryen.Module;
  moduleId: string;
  symbol: number;
}): boolean => reachableByModule.get(mod)?.has(keyOf(moduleId, symbol)) ?? false;

const keyOf = (moduleId: string, symbol: number): string =>
  `${moduleId}:${symbol}`;
