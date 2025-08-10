import { CompileExprOpts, mapBinaryenType, compileExpression } from "../assembler.js";
import { ObjectLiteral } from "../syntax-objects/object-literal.js";
import { ObjectType } from "../syntax-objects/types.js";
import { getExprType } from "../semantics/resolution/get-expr-type.js";
import { initStruct } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<ObjectLiteral>) => {
  const { expr: obj, mod } = opts;

  const objectType = getExprType(obj) as ObjectType;
  const literalBinType = mapBinaryenType(
    { ...opts, useOriginalType: true },
    objectType
  );

  return initStruct(mod, literalBinType, [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.fieldLookupHelpers.lookupTableType
    ),
    ...obj.fields.map((field) =>
      compileExpression({ ...opts, expr: field.initializer })
    ),
  ]);
};

