import {
  Expr,
  Identifier,
  List,
  Type,
  Fn,
  Parameter,
  ExternFn,
} from "../../lib/index.mjs";
import { SyntaxMacro } from "../types.mjs";

/** Registers any explicitly type annotated values */
export const registerAnnotatedTypes: SyntaxMacro = (list) => {
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

const initExternFn = (expr: List): ExternFn => {
  const parent = expr.parent!;
  const name = expr.identifierAt(1);
  const namespace = expr.listAt(2).identifierAt(1);
  const parameters = expr
    .listAt(3)
    .value.slice(1)
    .map((p) => listToParameter(p as List));
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr, 4);

  if (!suppliedReturnType) {
    throw new Error(`Missing return type for extern fn ${name}`);
  }

  const fn = new ExternFn({
    name,
    returnType: suppliedReturnType,
    parameters,
    namespace: namespace.toString(),
    ...expr.context,
  });

  parent.registerEntity(fn);
  return fn;
};

const getSuppliedReturnTypeForFn = (
  list: List,
  defIndex: number
): Type | undefined => {
  const definition = list.at(defIndex);
  if (!definition?.isList()) return undefined;
  const identifier = definition.at(1); // Todo: Support inline context data types?
  if (!identifier?.isIdentifier()) return undefined;
  const type = identifier.resolve();
  if (!type) return undefined;
  if (!type.isType()) {
    throw new Error(`${identifier} is not a type`);
  }
  return type;
};

// Accepts (label name )
export const listToParameter = (list: List) => {
  const isLabeled = list.at(2)?.isList();
  const paramDef = isLabeled ? (list.at(2) as List) : list;
  const label = isLabeled ? list.identifierAt(1) : undefined;
  const name = paramDef.identifierAt(1);
  const type = paramDef.identifierAt(2).resolve();

  if (!type?.isType()) {
    throw new Error(`Could not resolve type for parameter ${name}`);
  }

  return new Parameter({ name, label, type, ...list.context });
};
