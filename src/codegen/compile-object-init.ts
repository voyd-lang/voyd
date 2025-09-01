import { CompileExprOpts, compileExpression, mapBinaryenType } from "../codegen.js";
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
  if (!obj?.isObjectLiteral?.()) {
    const fnName = expr.fn?.isObjectType?.() ? expr.fn.name.toString() : expr.fnName.toString();
    throw new Error(
      `Expected object literal for ${fnName} init, got ${JSON.stringify(
        expr.argAt(0)
      )} at ${expr.location}`
    );
  }

  return gc.initStruct(mod, objectBinType, [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.fieldLookupHelpers.lookupTableType
    ),
    mod.global.get(
      `__method_table_${objectType.id}`,
      opts.methodLookupHelpers.lookupTableType
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
