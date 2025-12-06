import type { HirGraph } from "../hir/index.js";
import { createLowerContext } from "./context.js";
import {
  getModuleDeclarations,
  lowerFunctionDecl,
  lowerObjectDecl,
  lowerTypeAliasDecl,
  lowerTraitDecl,
  lowerImplDecl,
  lowerUseDecl,
  lowerEffectDecl,
} from "./declarations.js";
import type { LowerInputs } from "./types.js";

export * from "./types.js";

export const runLoweringPipeline = (inputs: LowerInputs): HirGraph => {
  const ctx = createLowerContext(inputs);
  const declarations = getModuleDeclarations(inputs.binding);

  for (const decl of declarations) {
    if (decl.kind === "use") {
      lowerUseDecl(decl.use, ctx);
      continue;
    }

    if (decl.kind === "function") {
      lowerFunctionDecl(decl.fn, ctx);
      continue;
    }

    if (decl.kind === "object") {
      lowerObjectDecl(decl.object, ctx);
      continue;
    }

    if (decl.kind === "trait") {
      lowerTraitDecl(decl.trait, ctx);
      continue;
    }

    if (decl.kind === "impl") {
      lowerImplDecl(decl.impl, ctx);
      continue;
    }

    if (decl.kind === "effect") {
      lowerEffectDecl(decl.effect, ctx);
      continue;
    }

    lowerTypeAliasDecl(decl.alias, ctx);
  }

  return ctx.builder.finalize();
};
