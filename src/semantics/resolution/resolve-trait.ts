import { Trait } from "../../syntax-objects/trait.js";
import { resolveFn } from "./resolve-fn.js";

export const resolveTrait = (trait: Trait) => {
  trait.methods.applyMap((fn) => resolveFn(fn));
  return trait;
};
