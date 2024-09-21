import { Block } from "../../syntax-objects/block.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { VoidModule } from "../../syntax-objects/module.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import {
  DsArrayType,
  ObjectType,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { Variable } from "../../syntax-objects/variable.js";
import { getExprType } from "./get-expr-type.js";
import { resolveCallTypes } from "./resolve-call-types.js";
import { resolveFnTypes } from "./resolve-fn-type.js";
import { resolveImpl } from "./resolve-impl.js";
import { resolveIntersection } from "./resolve-intersection.js";
import { resolveMatch } from "./resolve-match.js";
import { resolveObjectTypeTypes } from "./resolve-object-type.js";
import { resolveUnion } from "./resolve-union.js";
import { resolveUse } from "./resolve-use.js";

/**
 * NOTE: Some mapping is preformed on the AST at this stage.
 * Returned tree not guaranteed to be same as supplied tree
 *
 * Should probably rename this to resolveEntities and separate type resolution
 * into a new resolveTypes function that returns Type | undefined
 */
export const resolveTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isBlock()) return resolveBlockTypes(expr);
  if (expr.isCall()) return resolveCallTypes(expr);
  if (expr.isFn()) return resolveFnTypes(expr);
  if (expr.isVariable()) return resolveVarTypes(expr);
  if (expr.isModule()) return resolveModuleTypes(expr);
  if (expr.isList()) return resolveListTypes(expr);
  if (expr.isUse()) return resolveUse(expr, resolveModuleTypes);
  if (expr.isObjectType()) return resolveObjectTypeTypes(expr);
  if (expr.isDsArrayType()) return resolveDsArrayTypeTypes(expr);
  if (expr.isTypeAlias()) return resolveTypeAliasTypes(expr);
  if (expr.isObjectLiteral()) return resolveObjectLiteralTypes(expr);
  if (expr.isMatch()) return resolveMatch(expr);
  if (expr.isImpl()) return resolveImpl(expr);
  if (expr.isUnionType()) return resolveUnion(expr);
  if (expr.isIntersectionType()) return resolveIntersection(expr);
  return expr;
};

const resolveBlockTypes = (block: Block): Block => {
  block.applyMap(resolveTypes);
  block.type = getExprType(block.body.at(-1));
  return block;
};

export const resolveVarTypes = (variable: Variable): Variable => {
  const initializer = resolveTypes(variable.initializer);
  variable.initializer = initializer;
  variable.inferredType = getExprType(initializer);

  if (variable.typeExpr) {
    variable.annotatedType = getExprType(variable.typeExpr);
  }

  variable.type = variable.annotatedType ?? variable.inferredType;
  return variable;
};

export const resolveModuleTypes = (mod: VoidModule): VoidModule => {
  if (mod.phase >= 3) return mod;
  mod.phase = 3;
  mod.each(resolveTypes);
  mod.phase = 4;
  return mod;
};

const resolveListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(resolveTypes);
};

const resolveDsArrayTypeTypes = (arr: DsArrayType): DsArrayType => {
  arr.elemTypeExpr = resolveTypes(arr.elemTypeExpr);
  arr.elemType = getExprType(arr.elemTypeExpr);
  arr.id = `${arr.id}#${arr.elemType?.id}`;
  return arr;
};

const resolveTypeAliasTypes = (alias: TypeAlias): TypeAlias => {
  if (alias.type) return alias;
  alias.typeExpr = resolveTypes(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  return alias;
};

const resolveObjectLiteralTypes = (obj: ObjectLiteral) => {
  obj.fields.forEach((field) => {
    field.initializer = resolveTypes(field.initializer);
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
