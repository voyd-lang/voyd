import { Block } from "../../syntax-objects/block.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
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
import { maybeExpandObjectArg } from "./object-arg-utils.js";

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

const getArrayElemType = (type?: Type): Type | undefined => {
  if (!type?.isObjectType()) return;
  const parent = type.genericParent;
  if (!type.name.is("Array") && !parent?.name.is("Array")) return;
  const arg = type.appliedTypeArgs?.[0];
  return arg && arg.isTypeAlias() ? arg.type : undefined;
};

export const resolveVar = (variable: Variable): Variable => {
  if (variable.typeExpr) {
    variable.typeExpr = resolveTypeExpr(variable.typeExpr);
    variable.annotatedType = getExprType(variable.typeExpr);
    variable.type = variable.annotatedType;
  }

  let init = variable.initializer;
  if (variable.type) {
    init = resolveWithExpected(init, variable.type);
  } else if (init.isArrayLiteral()) {
    init = resolveArrayLiteral(init);
  } else {
    init = resolveEntities(init);
  }
  variable.initializer = init;
  variable.inferredType = getExprType(init);

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

const resolveListTypes = (list: List) => list.map(resolveEntities);

const resolveTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (alias.type || alias.resolutionPhase > 0) return alias;
  alias.resolutionPhase = 1;
  alias.typeExpr = resolveTypeExpr(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  return alias;
};

const unwrapAlias = (type?: Type): Type | undefined => {
  return type?.isTypeAlias() ? type.type ?? type : type;
};

const findObjectType = (
  type: Type | undefined,
  name: Identifier
): ObjectType | undefined => {
  const matches: ObjectType[] = [];
  const search = (t?: Type) => {
    t = unwrapAlias(t);
    if (!t) return;
    if (t.isObjectType()) {
      if (t.name.is(name) || t.genericParent?.name.is(name)) matches.push(t);
      return;
    }
    if (t.isUnionType()) t.types.forEach(search);
  };
  search(type);
  return matches.length === 1 ? matches[0] : undefined;
};

export const resolveWithExpected = (expr: Expr, expected?: Type): Expr => {
  if (!expected) return resolveEntities(expr);
  const unwrapped = unwrapAlias(expected);
  if (expr.isArrayLiteral()) {
    const elem = getArrayElemType(unwrapped);
    return resolveArrayLiteral(expr, elem);
  }
  if (expr.isCall()) {
    const resolvedExpr = resolveCall(expr);
    if (!resolvedExpr.isCall()) return resolvedExpr;
    const resolved = resolvedExpr;
    const objType = findObjectType(unwrapped, resolved.fnName);
    if (objType) {
      resolved.fn = objType;
      resolved.type = objType;
      resolved.fnName.type = objType;
      const objArg = resolved.argAt(0);
      if (objArg?.isObjectLiteral()) {
        resolved.args.set(0, resolveObjectLiteral(objArg, objType));
      } else if (objArg) {
        // Expand non-literal object arg into a literal via member-access, so
        // nominal constructors can be type-checked and compiled uniformly.
        const expanded = maybeExpandObjectArg(
          resolveEntities(objArg.clone()),
          objType,
          resolved.metadata
        );
        if (expanded) {
          resolved.args.set(0, resolveEntities(expanded));
        }
      }
      return resolved;
    }
    return resolved;
  }
  if (expr.isObjectLiteral() && unwrapped?.isObjectType()) {
    return resolveObjectLiteral(expr, unwrapped);
  }
  return resolveEntities(expr);
};

export const resolveObjectLiteral = (
  obj: ObjectLiteral,
  expected?: ObjectType
) => {
  // Ensure expected structural type (incl. tuples) is resolved so its field
  // types are available for propagation.
  if (expected) expected = resolveObjectType(expected);

  const isVsxCreateArgs = !!obj.getAttribute("vsx-create-element-args");
  obj.fields.forEach((field) => {
    const expectedField = expected?.getField(field.name)?.type;
    // DEBUG: trace tuple expected propagation
    if (process.env.VOYD_DEBUG?.includes("tuple-prop") && expected && (field.name === "0" || field.name === "1")) {
      console.log(
        `resolveObjectLiteral: expected ${expected.id} field ${field.name} -> ${expectedField?.id}`
      );
    }
    // For VSX create_element args, defer resolving array literals here so
    // they can be coerced later with the proper expected element types.
    if (isVsxCreateArgs && field.initializer.isArrayLiteral()) {
      // Leave as-is; normalizeArgsForResolvedFn will handle it
      field.type = expectedField;
      return field;
    }
    field.initializer = resolveWithExpected(field.initializer, expectedField);
    // Prefer the expected type for the field when provided to ensure
    // structural literals (incl. tuples) adopt the expected shape instead of
    // the initializer's narrower inferred type. This avoids accessor type
    // mismatches at runtime (e.g., tuple value typed as MsgPack vs String).
    field.type = expectedField ?? getExprType(field.initializer);
    return field;
  });

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

  return obj;
};

export const resolveArrayLiteral = (
  arr: ArrayLiteral,
  expectedElemType?: Type
): Expr => {
  // Defer resolving VSX arrays without an expected element type so we avoid
  // constructing a FixedArray with unknown element type. These will be
  // coerced later once parameter types are known.
  if (arr.getAttribute("vsx-array") && !expectedElemType) {
    arr.elements = arr.elements.map(resolveEntities);
    return arr;
  }
  const original = arr.clone();

  arr.elements = arr.elements.map((elem) => {
    if (expectedElemType) {
      // If nested arrays, push down the element type recursively; otherwise
      // resolve this element against the expected element type (covers tuple
      // and structural object elements as well).
      if (elem.isArrayLiteral()) {
        const childExpected =
          getArrayElemType(expectedElemType) ?? expectedElemType;
        return resolveArrayLiteral(elem, childExpected);
      }
      // DEBUG: trace array element expected propagation
      if (process.env.VOYD_DEBUG?.includes("tuple-prop")) {
        console.log(
          `resolveArrayLiteral: expected elemType ${expectedElemType.id}`
        );
      }
      return resolveWithExpected(elem, expectedElemType);
    }
    return resolveEntities(elem);
  });
  const elemType =
    expectedElemType ??
    combineTypes(
      arr.elements.map((e) => getExprType(e)).filter((t): t is Type => !!t)
    );

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
  if (!elemType && process.env.VOYD_DEBUG?.includes("vsx")) {
    console.warn(
      `resolveArrayLiteral: missing elemType for FixedArray at ${fixedArray.location}`
    );
  }
  newArrayCall.setTmpAttribute("arrayLiteral", original);
  return resolveEntities(newArrayCall);
};
