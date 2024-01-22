import {
  Expr,
  List,
  Type,
  Fn,
  Parameter,
  ExternFn,
} from "../syntax-objects/index.mjs";
import { SyntaxMacro } from "../types.mjs";

/** Registers any explicitly type annotated values */
export const registerAnnotatedTypes = (list: List) => {
  scanAnnotatedTypes(list);
  return list;
};

const scanAnnotatedTypes = (expr: Expr) => {
  if (!expr.isList()) return;

  if (expr.calls("define-function")) {
    initFn(expr);
    return;
  }

  if (expr.calls("define-extern-function")) {
    initExternFn(expr);
    return;
  }

  expr.value.forEach(scanAnnotatedTypes);
};

const initFn = (expr: List): Fn => {
  const parent = expr.parent!;
  const name = expr.identifierAt(1);
  const parameters = expr
    .listAt(2)
    .value.slice(1)
    .map((p) => listToParameter(p as List));
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr, 3);
  const body = expr.slice(4);

  const fn = new Fn({
    name,
    returnType: suppliedReturnType,
    parameters,
    body,
    ...expr.context,
  });

  parent.registerEntity(fn);
  return fn;
};
