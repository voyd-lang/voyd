import binaryen from "binaryen";
import { CompileExprOpts, compileExpression } from "../codegen.js";
import { asStmt } from "../lib/as-stmt.js";
import { VoydModule } from "../syntax-objects/module.js";

export const compile = (opts: CompileExprOpts<VoydModule>) => {
  const { mod, expr } = opts;
  const statements = expr.value.map((expr) =>
    asStmt(mod, compileExpression({ ...opts, expr, isReturnExpr: false }))
  );
  const result = mod.block(expr.id, statements, binaryen.none);

  if (opts.expr.isIndex) {
    opts.expr.getAllExports().forEach((entity) => {
      if (entity.isFn()) {
        opts.mod.addFunctionExport(entity.id, entity.name.value);
      }
    });
  }

  return result;
};

