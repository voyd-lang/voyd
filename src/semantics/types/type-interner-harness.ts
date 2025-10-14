import type { Expr } from "../../syntax-objects/expr.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { parseModule } from "../../parser/index.js";
import { registerModules } from "../modules.js";
import { expandFunctionalMacros } from "../functional-macros.js";
import { initPrimitiveTypes } from "../init-primitive-types.js";
import { initEntities } from "../init-entities.js";
import { resolveEntities } from "../resolution/resolve-entities.js";
import { checkTypes } from "../check-types/index.js";
import { canonicalizeResolvedTypes } from "./canonicalize-resolved-types.js";
import {
  TypeInterner,
  type TypeInternerEvent,
  type TypeInternerOptions,
  type TypeInternerStats,
} from "./type-interner.js";

export type TypeInternerHarnessResult = {
  root: VoydModule;
  interner: TypeInterner;
  stats: TypeInternerStats;
  events: TypeInternerEvent[];
};

const semanticPipeline = (root: Expr): Expr =>
  [expandFunctionalMacros, initPrimitiveTypes, initEntities, resolveEntities].reduce(
    (acc, phase) => phase(acc),
    root
  );

export const resolveVoydModule = async (source: string): Promise<VoydModule> => {
  const parsed = await parseModule(source);
  const registered = registerModules(parsed);
  const resolved = semanticPipeline(registered);
  const checked = checkTypes(resolved) as VoydModule;
  return checked;
};

export const runTypeInternerOnModule = (
  module: VoydModule,
  options: TypeInternerOptions = {}
): TypeInternerHarnessResult => {
  const interner = new TypeInterner(options);
  canonicalizeResolvedTypes(module, {
    onType: (type) => interner.intern(type),
  });
  return {
    root: module,
    interner,
    stats: interner.getStats(),
    events: interner.getEvents(),
  };
};

export const runTypeInternerFromSource = async (
  source: string,
  options: TypeInternerOptions = {}
): Promise<TypeInternerHarnessResult> => {
  const module = await resolveVoydModule(source);
  return runTypeInternerOnModule(module, options);
};
