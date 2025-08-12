import { CompileExprOpts, compileExpression, mapBinaryenType } from "../assembler.js";
import { Call } from "../syntax-objects/call.js";
import { ObjectLiteral } from "../syntax-objects/object-literal.js";
import { ObjectType } from "../syntax-objects/types.js";
import { getExprType } from "../semantics/resolution/get-expr-type.js";
import * as gc from "../lib/binaryen-gc/index.js";

export const compileObjectInit = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;

  const objectType = getExprType(expr) as ObjectType;
  const objectBinType = mapBinaryenType(opts, objectType);
  const obj = expr.argAt(0) as ObjectLiteral;

  return gc.initStruct(mod, objectBinType, [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.fieldLookupHelpers.lookupTableType
    ),
    ...obj.fields.map((field) =>
      compileExpression({
        ...opts,
        expr: field.initializer,
        isReturnExpr: false,
      })
    ),
  ]);
};
