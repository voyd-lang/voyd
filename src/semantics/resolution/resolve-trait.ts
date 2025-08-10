import { TraitType } from "../../syntax-objects/types/trait.js";
import { resolveFn } from "./resolve-fn.js";

export const resolveTrait = (trait: TraitType) => {
  trait.methods.applyMap((fn) => resolveFn(fn));
  return trait;
};
