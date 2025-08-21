import binaryen from "binaryen";
import { CompileExprOpts, compileExpression, asStmt } from "../codegen.js";
import { VoydModule } from "../syntax-objects/module.js";

export const compile = (opts: CompileExprOpts<VoydModule>) => {
  const { mod, expr } = opts;
  const result = mod.block(
    expr.id,
    expr.value.map((e) => asStmt(mod, compileExpression({ ...opts, expr: e }))),
    binaryen.none
  );

  if (expr.isIndex) {
    expr.getAllExports().forEach((entity) => {
      if (entity.isFn()) {
        mod.addFunctionExport(entity.id, entity.name.value);
      }
    });
  }

  return result;
};

