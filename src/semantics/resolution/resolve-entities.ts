import { Block } from "../../syntax-objects/block.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
import { Closure } from "../../syntax-objects/closure.js";
import {
  ObjectType,
  TypeAlias,
  voydBaseObject,
  Type,
} from "../../syntax-objects/types.js";
import { Variable } from "../../syntax-objects/variable.js";
import { getExprType } from "./get-expr-type.js";
import { resolveCall } from "./resolve-call.js";
import { resolveClosure } from "./resolve-closure.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveImpl } from "./resolve-impl.js";
import { resolveMatch } from "./resolve-match.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveTrait } from "./resolve-trait.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { combineTypes } from "./combine-types.js";
import { resolveUse } from "./resolve-use.js";
import { selfType } from "../../syntax-objects/types.js";

/**
 * NOTE: Some mapping is preformed on the AST at this stage.
 * Returned tree not guaranteed to be same as supplied tree.
 */
export const resolveEntities = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isIdentifier()) {
    captureIdentifier(expr);
    return expr;
  }
  if (expr.isBlock()) return resolveBlock(expr);
  if (expr.isCall()) return resolveCall(expr);
  if (expr.isFn()) return resolveFn(expr);
  if (expr.isClosure()) return resolveClosure(expr);
  if (expr.isVariable()) return resolveVar(expr);
  if (expr.isModule()) return resolveModule(expr);
  if (expr.isList()) return resolveListTypes(expr);
  if (expr.isUse()) return resolveUse(expr, resolveModule);
  if (expr.isObjectType()) return resolveObjectType(expr);
  if (expr.isTypeAlias()) return resolveTypeAlias(expr);
  if (expr.isObjectLiteral()) return resolveObjectLiteral(expr);
  if (expr.isArrayLiteral()) return resolveArrayLiteral(expr);
  if (expr.isMatch()) return resolveMatch(expr);
  if (expr.isImpl()) return resolveImpl(expr);
  if (expr.isTrait()) return resolveTrait(expr);
  return expr;
};

const captureIdentifier = (id: Identifier) => {
  if (id.is("self")) {
    let parent: Expr | undefined = id.parent;
    while (parent) {
      if (parent.isTrait()) {
        id.type = selfType;
        break;
      }
      if (parent.isImpl()) {
        break;
      }
      parent = parent.parent;
    }
  }

  // Populate the identifier's type for downstream consumers
  if (!id.type) {
    id.type = getExprType(id);
  }

  const parentFn = id.parentFn;
  if (!parentFn?.isClosure()) return;
  const entity = id.resolve();
  if (!entity) return;

  if (
    (entity.isVariable() || entity.isParameter()) &&
    entity.parentFn !== parentFn &&
    !(entity.isVariable() && entity.initializer === parentFn) &&
    !parentFn.captures.includes(entity)
  ) {
    parentFn.captures.push(entity);
  }
};

const resolveBlock = (block: Block): Block => {
  block.applyMap(resolveEntities);
  block.type = getExprType(block.body.at(-1));
  return block;
};

export const resolveVar = (variable: Variable): Variable => {
  if (variable.typeExpr) {
    variable.typeExpr = resolveTypeExpr(variable.typeExpr);
    variable.annotatedType = getExprType(variable.typeExpr);
    variable.type = variable.annotatedType;
  }

  const initializer = resolveEntities(variable.initializer);
  variable.initializer = initializer;
  variable.inferredType = getExprType(initializer);

  if (!variable.type) {
    variable.type = variable.inferredType;
  }
  return variable;
};

export const resolveModule = (mod: VoydModule): VoydModule => {
  if (mod.phase >= 3) return mod;
  mod.phase = 3;
  mod.each(resolveEntities);
  mod.phase = 4;
  return mod;
};

const resolveListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(resolveEntities);
};

const resolveTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (alias.type) return alias;
  alias.typeExpr = resolveTypeExpr(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  return alias;
};

const resolveObjectLiteral = (obj: ObjectLiteral) => {
  obj.fields.forEach((field) => {
    field.initializer = resolveEntities(field.initializer);
    field.type = getExprType(field.initializer);
    return field;
  });

  if (!obj.type) {
    obj.type = new ObjectType({
      ...obj.metadata,
      name: `ObjectLiteral-${obj.syntaxId}`,
      value: obj.fields.map((f) => ({
        name: f.name,
        typeExpr: f.initializer,
        type: f.type,
      })),
      parentObj: voydBaseObject,
      isStructural: true,
    });
  }

  return obj;
};

const resolveArrayLiteral = (arr: ArrayLiteral): Expr => {
  arr.elements = arr.elements.map(resolveEntities);
  const elemTypes = arr.elements
    .map((e) => getExprType(e))
    .filter((t): t is Type => !!t);
  const elemType = combineTypes(elemTypes);

  const fixedArray = new Call({
    ...arr.metadata,
    fnName: Identifier.from("FixedArray"),
    args: new List({ value: arr.elements }),
    typeArgs: elemType ? new List({ value: [elemType] }) : undefined,
  });

  const objLiteral = new ObjectLiteral({
    ...arr.metadata,
    fields: [{ name: "from", initializer: fixedArray }],
  });

  const typeArgs = elemType ? new List({ value: [elemType] }) : undefined;
  const newArrayCall = new Call({
    ...arr.metadata,
    fnName: Identifier.from("new_array"),
    args: new List({ value: [objLiteral] }),
    typeArgs,
  });

  return resolveEntities(newArrayCall);
};
