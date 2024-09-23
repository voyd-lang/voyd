import { Block } from "../../syntax-objects/block.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { VoidModule } from "../../syntax-objects/module.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import {
  FixedArrayType,
  ObjectType,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { Variable } from "../../syntax-objects/variable.js";
import { getExprType } from "./get-expr-type.js";
import { resolveCall } from "./resolve-call-types.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveImpl } from "./resolve-impl.js";
import { resolveIntersectionType } from "./resolve-intersection.js";
import { resolveMatch } from "./resolve-match.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveUnionType } from "./resolve-union.js";
import { resolveUse } from "./resolve-use.js";

/**
 * NOTE: Some mapping is preformed on the AST at this stage.
 * Returned tree not guaranteed to be same as supplied tree
 *
 * Should probably rename this to resolveEntities and separate type resolution
 * into a new resolveTypes function that returns Type | undefined
 */
export const resolveEntities = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isBlock()) return resolveBlock(expr);
  if (expr.isCall()) return resolveCall(expr);
  if (expr.isFn()) return resolveFn(expr);
  if (expr.isVariable()) return resolveVar(expr);
  if (expr.isModule()) return resolveModule(expr);
  if (expr.isList()) return resolveListTypes(expr);
  if (expr.isUse()) return resolveUse(expr, resolveModule);
  if (expr.isObjectType()) return resolveObjectType(expr);
  if (expr.isFixedArrayType()) return resolveFixedArrayType(expr);
  if (expr.isTypeAlias()) return resolveTypeAlias(expr);
  if (expr.isObjectLiteral()) return resolveObjectLiteral(expr);
  if (expr.isMatch()) return resolveMatch(expr);
  if (expr.isImpl()) return resolveImpl(expr);
  if (expr.isUnionType()) return resolveUnionType(expr);
  if (expr.isIntersectionType()) return resolveIntersectionType(expr);
  return expr;
};

const resolveBlock = (block: Block): Block => {
  block.applyMap(resolveEntities);
  block.type = getExprType(block.body.at(-1));
  return block;
};

export const resolveVar = (variable: Variable): Variable => {
  const initializer = resolveEntities(variable.initializer);
  variable.initializer = initializer;
  variable.inferredType = getExprType(initializer);

  if (variable.typeExpr) {
    variable.annotatedType = getExprType(variable.typeExpr);
  }

  variable.type = variable.annotatedType ?? variable.inferredType;
  return variable;
};

export const resolveModule = (mod: VoidModule): VoidModule => {
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

const resolveFixedArrayType = (arr: FixedArrayType): FixedArrayType => {
  arr.elemTypeExpr = resolveEntities(arr.elemTypeExpr);
  arr.elemType = getExprType(arr.elemTypeExpr);
  arr.id = `${arr.id}#${arr.elemType?.id}`;
  return arr;
};

const resolveTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (alias.type) return alias;
  alias.typeExpr = resolveEntities(alias.typeExpr);
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
    });
    obj.type.setAttribute("isStructural", true);
  }

  return obj;
};
