import {
  List,
  isList,
  Identifier,
  isPrimitiveType,
  CDT_ADDRESS_TYPE,
  FnType,
  Int,
} from "../lib/index.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";

export const memoryManagement = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  return insertMemInstructions(list);
};

const insertMemInstructions = (list: List): List =>
  list.reduce((expr) => {
    if (!isList(expr)) return expr;

    if (!expr.calls("define-function")) return insertMemInstructions(expr);

    const fnId = expr.at(1) as Identifier;
    const fn = fnId.getTypeOf() as FnType;

    if (isPrimitiveType(fn.returns)) return insertMemInstructions(expr);
    return addMemInstructionsToFunctionDef(expr, fn.returns!.size);
  });

const addMemInstructionsToFunctionDef = (
  list: List,
  allocationSize: number
): List => {
  const body = list.at(4)!;
  const returnAddr = "*__return_alloc_address";
  list.setVar(returnAddr, { kind: "var", type: CDT_ADDRESS_TYPE });
  list.value[4] = new List({
    from: list,
    value: [
      "typed-block",
      CDT_ADDRESS_TYPE,
      [
        "define",
        ["labeled-expr", returnAddr, CDT_ADDRESS_TYPE],
        ["alloc", new Int({ value: allocationSize })],
      ],
      ["set-return", ["copy", body, returnAddr]],
    ],
  });
  return list;
};
