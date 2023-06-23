import {
  List,
  Identifier,
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
    if (!expr.isList()) return expr;

    if (!expr.calls("define-function")) return insertMemInstructions(expr);

    const fnId = expr.at(1) as Identifier;
    const fn = fnId.getTypeOf() as FnType;

    if (fn.returnType.isPrimitiveType()) return insertMemInstructions(expr);
    return addMemInstructionsToFunctionDef(expr, fn.returnType.size);
  });

const addMemInstructionsToFunctionDef = (
  list: List,
  allocationSize: number
): List => {
  const body = list.at(4)!;
  const returnAddr = Identifier.from("*__return_alloc_address");
  returnAddr.setTypeOf(CDT_ADDRESS_TYPE);
  const alloc = getFnId(list, "alloc");
  const setReturn = getFnId(list, "set-return");
  const copy = getFnId(list, "copy");
  list.set(
    4,
    new List({
      ...list.value[4]?.context,
      value: [
        "typed-block",
        CDT_ADDRESS_TYPE,
        ["define", returnAddr, [alloc, new Int({ value: allocationSize })]],
        [setReturn, [copy, body, returnAddr]],
      ],
    })
  );
  return list;
};

const getFnId = (parent: List, name: string): Identifier => {
  const fnIdFn = parent.resolveFns(name)[0];
  const fnId = Identifier.from(name);
  fnId.setTypeOf(fnIdFn);
  return fnId;
};
