import { inferTypes } from "./infer-types.mjs";
import { initPrimitiveTypes } from "./init-primitive-types.mjs";
import { registerAnnotatedTypes } from "./register-annotated-types.mjs";

const typePhases: SyntaxMacro[] = [
  initPrimitiveTypes,
  registerAnnotatedTypes,
  inferTypes,
];

export const typeCheck: SyntaxMacro = (list, info) => {
  if (!info.isRoot) return list;
  return typePhases.reduce((ast, macro) => macro(ast, info), list);
};
