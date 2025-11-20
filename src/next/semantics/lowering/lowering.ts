import type { HirGraph } from "../hir/index.js";
import { createLowerContext } from "./context.js";
import {
  getModuleDeclarations,
  lowerFunctionDecl,
  lowerObjectDecl,
  lowerTypeAliasDecl,
} from "./declarations.js";
import type { LowerInputs } from "./types.js";

export * from "./types.js";

export const runLoweringPipeline = (inputs: LowerInputs): HirGraph => {
  const ctx = createLowerContext(inputs);
  const declarations = getModuleDeclarations(inputs.binding);

  for (const decl of declarations) {
    if (decl.kind === "function") {
      lowerFunctionDecl(decl.fn, ctx);
      continue;
    }

    if (decl.kind === "object") {
      lowerObjectDecl(decl.object, ctx);
      continue;
    }

    lowerTypeAliasDecl(decl.alias, ctx);
  }

  return ctx.builder.finalize();
};
