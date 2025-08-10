import { CompileExprOpts, compileExpression } from "../assembler.js";
import { VoydModule } from "../syntax-objects/module.js";

export const compile = (opts: CompileExprOpts<VoydModule>) => {
  const result = opts.mod.block(
    opts.expr.id,
    opts.expr.value.map((expr) => compileExpression({ ...opts, expr }))
  );

  if (opts.expr.isIndex) {
    opts.expr.getAllExports().forEach((entity) => {
      if (entity.isFn()) {
        opts.mod.addFunctionExport(entity.id, entity.name.value);
      }
    });
  }

  return result;
};

