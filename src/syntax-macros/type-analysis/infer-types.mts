import {
  List,
  Expr,
  noop,
  Identifier,
  FnType,
  ObjectType,
  BaseType,
  Type,
  i32,
  f32,
  bool,
  dVoid,
  PrimitiveType,
  StackType,
  Id,
  Fn,
  ExternFn,
  Parameter,
  Block,
  Call,
} from "../../lib/index.mjs";
import { getIdStr } from "../../lib/syntax/get-id-str.mjs";
import { FnEntity } from "../../lib/syntax/lexical-context.mjs";
import { SyntaxMacro } from "../types.mjs";
import { isPrimitiveFn } from "./lib/is-primitive-fn.mjs";

const modules = new Map<string, List>();

export const inferTypes: SyntaxMacro = (list): List =>
  inferExprTypes(list) as List;

const inferExprTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return noop();
  if (!expr.isList()) return expr;
  return inferFnCallTypes(expr);
};

const inferFnCallTypes = (list: List): Expr => {
  if (list.calls("define-function")) return inferFn(list);
  if (list.calls("block")) return inferBlockTypes(list);
  if (list.calls("export")) return inferExportTypes(list);
  if (list.calls("root")) return inferRootModuleTypes(list);
  if (list.calls("module")) return inferModuleTypes(list);
  if (list.calls("quote")) return list;

  if (list.calls("define-extern-function")) {
    return inferExternFn(list);
  }

  if (list.calls("bnr") || list.calls("binaryen-mod")) {
    return inferBnrCallTypes(list);
  }

  if (list.getIdStrAt(0)?.startsWith("define")) {
    return inferVarTypes(list);
  }

  if (isPrimitiveFn(list.at(0))) {
    return inferPrimitiveFnTypes(list);
  }

  return inferUserFnCallTypes(list);
};

const inferBnrCallTypes = (list: List): List => {
  const body = list.at(2) as List | undefined;
  body?.value.forEach((v) => inferExprTypes(v));
  return list;
};

const inferFn = (expr: List): Fn => {
  const parent = expr.parent!;
  const name = expr.identifierAt(1);
  const parameters = expr
    .listAt(2)
    .value.slice(1)
    .map((p) => listToParameter(p as List));
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr, 3);
  const body = inferBlockTypes(expr.listAt(4));
  const returnType = assertFunctionReturnType(body, suppliedReturnType, name);

  const fn = new Fn({
    name,
    returnType,
    parameters,
    body,
    ...expr.context,
  });

  parent.registerEntity(fn);
  return fn;
};

const inferExternFn = (expr: List): ExternFn => {
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

const inferBlockTypes = (list: List): Block => {
  const annotatedArgs = list.slice(1).map((expr) => inferExprTypes(expr));

  const type = getExprReturnType(annotatedArgs.at(-1));

  if (!type) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not determine return type of preceding block");
  }

  return new Block({
    ...list.context,
    body: annotatedArgs.value,
    returnType: type,
  });
};

const inferPrimitiveFnTypes = (list: List): List => {
  if (list.calls("=")) {
    return addTypeAnnotationsToAssignment(list);
  }

  return list.mapArgs(inferExprTypes);
};

const addTypeAnnotationsToAssignment = (list: List): List => {
  return list.mapArgs(inferExprTypes);
};

function inferUserFnCallTypes(list: List): Call {
  const identifier = list.identifierAt(0);
  const args = list.rest().map(inferExprTypes);
  const fn = getMatchingFnForCallExpr(identifier, args);
  if (!fn) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  return new List({ ...list.context, value: [identifier, ...annotatedArgs] });
}

/** Re-orders the supplied struct and returns it as a normal list of expressions to be passed as args */
const applyStructParams = (
  expectedStruct: ObjectType,
  suppliedStruct: List
): Expr[] =>
  expectedStruct.value.map(({ name }) => {
    const arg = suppliedStruct
      .slice(1)
      .value.find((expr) => (expr as List).calls(name, 1)) as List;
    if (!arg) throw new Error(`Could not find arg for field ${name}`);
    return arg.at(2)!;
  });

const inferRootModuleTypes = (list: List): List =>
  list.map((expr) => inferExprTypes(expr));

const inferModuleTypes = (list: List): List => {
  modules.set((list.at(1) as Identifier)!.value, list);
  const imports = list.at(2) as List;
  const exports = list.at(3) as List;
  const body = list.at(4) as List;
  resolveImports(imports, exports);
  list.value[4] = body.map((expr) => inferExprTypes(expr));
  resolveExports({ exports, body: list.at(4) as List });
  return list;
};

// This is probably super problematic
const resolveImports = (imports: List, exports: List): void => {
  const parent = imports.getParent()!;
  for (const imp of imports.value) {
    if (!isList(imp)) continue;
    const module = modules.get(imp.at(0)!.value as string);
    const isReExported = imp.at(2)?.is("re-exported");
    if (!module) continue;
    // TODO support import patterns other than ***
    for (const exp of module.at(3)?.value as Expr[]) {
      if (!exp.isIdentifier() || exp.is("exports")) continue;
      const type = exp.getTypeOf();

      if (type instanceof FnType) {
        parent.addFn(exp, type);
        if (isReExported) exports.push(exp);
        continue;
      }

      if (exp.resolve && exp.resolve.kind === "global") {
        parent.addVar(exp, exp.resolve);
        if (isReExported) exports.push(exp);
        continue;
      }

      if (type instanceof BaseType) {
        parent.addType(exp, type);
        if (isReExported) exports.push(exp);
        continue;
      }
    }
  }
};

const resolveExports = ({
  exports,
  body,
}: {
  exports: List;
  body: List;
}): void => {
  body.value.forEach((expr) => {
    if (!expr.isList()) return;
    if (expr.calls("export")) {
      exports.push(expr.at(1) as Identifier);
      return;
    }
    return resolveExports({ exports, body: expr });
  });
};

const inferVarTypes = (list: List): List => {
  const varFnId = list.at(0) as Identifier;
  const mut = varFnId.value.includes("define-mut");
  const global = varFnId.value.includes("global");
  const initializer = list.at(2);
  const inferredType = getExprReturnType(initializer);
  const annotatedInitializer = inferExprTypes(initializer?.clone());
  // Get identifier from a potentially untyped definition
  const def = list.at(1)!;
  const identifier = def.isList()
    ? (def.at(1) as Identifier) // Typed case
    : (def as Identifier); // Untyped case
  const suppliedType = def.isList()
    ? isStruct(def)
      ? typedStructListToStructType(def)
      : getTypeFromLabeledExpr(def)
    : undefined;

  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(
      `Could not determine type for identifier ${identifier.value}`
    );
  }

  identifier.setTypeOf(type);
  list.parent?.addVar(identifier, {
    kind: global ? "global" : "var",
    mut,
    type,
  });

  return new List({
    ...list.context,
    value: [varFnId, identifier, annotatedInitializer],
  });
};

const getTypeFromLabeledExpr = (def: List): Type | undefined => {
  if (!def.calls("labeled-expr")) {
    throw new Error("Expected labeled expression");
  }
  const typeId = def.at(2);
  if (!typeId?.isIdentifier()) {
    throw new Error("Param type annotations must be identifiers (for now)");
  }

  return def.getType(typeId);
};

const getExprReturnType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return i32;
  if (expr.isFloat()) return f32;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier() && expr.is("void")) return dVoid;
  if (expr.isIdentifier()) return expr.getTypeOf();
  if (!expr.isList()) throw new Error(`Invalid expression ${expr}`);

  if (expr.calls("labeled-expr")) return getExprReturnType(expr.at(2));
  if (expr.calls("block")) return getExprReturnType(expr.at(-1));
  if (expr.calls("struct")) return getStructLiteralType(expr);
  if (expr.calls("bnr") || expr.calls("binaryen-mod")) {
    return getBnrReturnType(expr);
  }
  if (expr.calls("if")) return getIfReturnType(expr);

  const fn = getMatchingFnForCallExpr(expr);
  return fn?.returnType;
};

/** Takes the expression form of a struct and converts it into type form */
const getStructLiteralType = (ast: List): ObjectType =>
  new ObjectType({
    ...ast.context,
    name: "literal",
    value: ast.slice(1).value.map((labeledExpr) => {
      const list = labeledExpr as List;
      const identifier = list.at(1) as Identifier;
      const type = getExprReturnType(list.at(2));
      if (!type) {
        throw new Error("Could not determine type for struct literal");
      }
      return { name: identifier.value, type };
    }),
  });

// TODO type check this mofo
const getIfReturnType = (list: List): Type | undefined =>
  getExprReturnType(list.at(2));

const getBnrReturnType = (call: List): Type | undefined => {
  const info = call.at(1) as List | undefined;
  const id = info?.at(2) as Identifier;
  return new PrimitiveType({ ...id.context, name: id.value as StackType });
};

const getMatchingFnForCallExpr = (
  identifier: Identifier,
  args: Expr[]
): FnEntity | undefined => {
  const candidates = identifier.resolveFns(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) => {
    const params = candidate.parameters;
    return params.every((p, index) => {
      const arg = args.at(index);
      if (!arg) return false;
      const argType = getExprReturnType(arg);
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return typesMatch(p.type, argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!expr?.isList()) return;
  if (!expr.calls("labeled-expr")) return;
  return expr.getIdStrAt(1);
};

const inferExportTypes = (exp: List) => {
  const exportId = exp.at(1);
  if (!exportId?.isIdentifier()) {
    throw new Error("Missing identifier in export");
  }

  const params = exp.at(2);
  if (params?.isList() && params.calls("parameters")) {
    inferFnExportTypes(exportId, params);
    return exp;
  }

  return exp;
};

const inferFnExportTypes = (fnId: Identifier, params: List) => {
  const candidates = fnId.resolveFns(fnId);
  const fn = candidates.find((candidate) =>
    candidate.value.params.every((param, index) => {
      const p = params.at(index + 1);
      if (!p?.isList()) return false;
      const { label, name: identifier, type } = getInfoFromRawParam(p as List);
      const identifiersMatch = identifier ? identifier.is(param.name) : true;
      const labelsMatch = label ? label.is(param.label) : true;
      const typesDoMatch = typesMatch(param.type, type);
      return typesDoMatch && identifiersMatch && labelsMatch;
    })
  );

  if (!fn) {
    console.error(JSON.stringify([fnId, params], null, 2));
    throw new Error(`Fn ${fnId} not found for the above export expression`);
  }

  fnId.setTypeOf(fn);
};

function assertFunctionReturnType(
  block: Block,
  suppliedReturnType: Type | undefined,
  id: Id
): Type {
  const inferredReturnType = block.returnType;

  const shouldCheckInferredType =
    suppliedReturnType && !suppliedReturnType.isEquivalentTo(dVoid);

  const typeMismatch =
    shouldCheckInferredType &&
    !suppliedReturnType.isEquivalentTo(inferredReturnType);

  if (typeMismatch) {
    const name = getIdStr(id);
    throw new Error(
      `Expected fn ${name} to return ${suppliedReturnType}, got ${inferredReturnType}`
    );
  }

  return inferredReturnType;
}
