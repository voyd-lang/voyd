import {
  List,
  Expr,
  noop,
  Identifier,
  ObjectType,
  Type,
  i32,
  f32,
  bool,
  dVoid,
  PrimitiveType,
  StackType,
  Id,
  Fn,
  Block,
  Call,
  Variable,
} from "../syntax-objects/index.mjs";
import { getIdStr } from "../syntax-objects/get-id-str.mjs";
import { FnEntity } from "../syntax-objects/lexical-context.mjs";
import { isPrimitiveFn } from "./lib/is-primitive-fn.mjs";

const checkTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return noop();
  if (expr.isBlock()) return evalBlockTypes(expr);
  if (expr.isCall()) return evalCallTypes(expr);
  if (expr.isFn()) return inferFn(expr);
  if (expr.isVariable()) return evalVarTypes(expr);
  if (expr.isModule()) return evalModuleTypes(expr);
  if (expr.isList()) return evalListTypes(expr);
  return expr;
};

const evalBlockTypes = (block: Block): Block => {};

const evalCallTypes = (call: Call): Call => {
  if (call.calls("export")) return evalExport(call);
};

const inferBnrCallTypes = (list: List): List => {
  const body = list.at(2) as List | undefined;
  body?.value.forEach((v) => checkTypes(v));
  return list;
};

const inferFn = (fn: Fn): Fn => {};

const evalModuleTypes = (list: List): List => {};

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

const evalVarTypes = (list: List): Variable => {
  const parent = list.parent;
  const varFnId = list.identifierAt(0);
  const isMutable = varFnId.value.includes("define-mut");
  const initializer = checkTypes(list.at(2));
  const inferredType = getExprReturnType(initializer);

  // Get identifier from a potentially untyped definition
  const def = list.at(1)!;
  const name = def.isList()
    ? def.identifierAt(1) // Typed case
    : (def as Identifier); // Untyped case

  const suppliedType = def.isList() ? getTypeFromLabeledExpr(def) : undefined;

  if (suppliedType && !(inferredType?.isEquivalentTo(suppliedType) ?? true)) {
    throw new Error(
      `${name} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(`Could not determine type for identifier ${name.value}`);
  }

  const variable = new Variable({
    ...list.metadata,
    name,
    initializer,
    isMutable,
    type,
  });

  parent?.registerEntity(variable);

  return variable;
};

const getTypeFromLabeledExpr = (def: List): Type => {
  if (!def.calls("labeled-expr")) {
    throw new Error("Expected labeled expression");
  }

  const typeId = def.identifierAt(2);

  const type = typeId.resolve();

  if (!type?.isType()) {
    throw new Error(`${typeId} is not a type`);
  }

  return type;
};

const getExprReturnType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return i32;
  if (expr.isFloat()) return f32;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) return expr.type;
  if (!expr.isList()) throw new Error(`Invalid expression ${expr}`);

  if (expr.calls("labeled-expr")) return getExprReturnType(expr.at(2));
  if (expr.calls("block")) return getExprReturnType(expr.at(-1));
  if (expr.calls("object")) return getObjectLiteralType(expr);
  if (expr.calls("bnr") || expr.calls("binaryen-mod")) {
    return getBnrReturnType(expr);
  }
  if (expr.calls("if")) return getIfReturnType(expr);
};

const getIdentifierType = (id: Identifier): Type | undefined => {
  const entity = id.resolve();
  if (!entity) return;
  if (entity.isVariable()) return entity.type;
  if (entity.isGlobal()) return entity.type;
  if (entity.isParameter()) return entity.type;
  if (entity.isFn()) return entity.getType();
  if (entity.isType()) return entity;
};

/** Takes the expression form of a struct and converts it into type form */
const getObjectLiteralType = (ast: List): ObjectType =>
  new ObjectType({
    ...ast.metadata,
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

const evalListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(checkTypes);
};

// TODO type check this mofo
const getIfReturnType = (list: List): Type | undefined =>
  getExprReturnType(list.at(2));

const getBnrReturnType = (call: List): Type | undefined => {
  const info = call.at(1) as List | undefined;
  const id = info?.at(2) as Identifier;
  return new PrimitiveType({ ...id.metadata, name: id.value as StackType });
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
      if (!argType) {
        throw new Error(`Could not determine type for ${arg}`);
      }
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return p.type.isEquivalentTo(argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!expr?.isList()) return;
  if (!expr.calls("labeled-expr")) return;
  return expr.getIdStrAt(1);
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
