import { Block } from "../../syntax-objects/block.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import {
  ObjectType,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { Variable } from "../../syntax-objects/variable.js";
import { getExprType } from "./get-expr-type.js";
import { resolveCall } from "./resolve-call.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveImpl } from "./resolve-impl.js";
import { resolveMatch } from "./resolve-match.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveTrait } from "./resolve-trait.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { resolveUse } from "./resolve-use.js";

/**
 * NOTE: Some mapping is preformed on the AST at this stage.
 * Returned tree not guaranteed to be same as supplied tree.
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
  if (expr.isTypeAlias()) return resolveTypeAlias(expr);
  if (expr.isObjectLiteral()) return resolveObjectLiteral(expr);
  if (expr.isMatch()) return resolveMatch(expr);
  if (expr.isImpl()) return resolveImpl(expr);
  if (expr.isTrait()) return resolveTrait(expr);
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
    variable.typeExpr = resolveTypeExpr(variable.typeExpr);
    variable.annotatedType = getExprType(variable.typeExpr);
  }

  variable.type = variable.annotatedType ?? variable.inferredType;
  return variable;
};

export const resolveModule = (mod: VoydModule): VoydModule => {
  if (mod.phase >= 3) return mod;
  mod.phase = 3;
  mod.applyMap((expr) => resolveEntities(expr));
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
