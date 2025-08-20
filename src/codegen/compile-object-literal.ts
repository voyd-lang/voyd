import { CompileExprOpts, mapBinaryenType, compileExpression } from "../codegen.js";
import { ObjectLiteral } from "../syntax-objects/object-literal.js";
import { ObjectType } from "../syntax-objects/types.js";
import { initStruct } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<ObjectLiteral>) => {
  const { expr: obj, mod } = opts;

  const objectType = obj.getType() as ObjectType;
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
    mod.global.get(
      `__method_table_${objectType.id}`,
      opts.methodLookupHelpers.lookupTableType
    ),
    ...obj.fields.map((field) =>
      compileExpression({ ...opts, expr: field.initializer })
    ),
  ]);
};

