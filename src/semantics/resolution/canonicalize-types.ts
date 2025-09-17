import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
import { Block } from "../../syntax-objects/block.js";
import { Call } from "../../syntax-objects/call.js";
import { Closure } from "../../syntax-objects/closure.js";
import { Declaration } from "../../syntax-objects/declaration.js";
import { Expr } from "../../syntax-objects/expr.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { List } from "../../syntax-objects/list.js";
import { Match } from "../../syntax-objects/match.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { Variable } from "../../syntax-objects/variable.js";

type KeyState = {
  memo: Map<Type, string>;
  stack: Map<Type, number>;
};

const createKeyState = (): KeyState => ({
  memo: new Map<Type, string>(),
  stack: new Map<Type, number>(),
});

const unwrapAlias = (type?: Type | null): Type | undefined => {
  const seen = new Set<Type>();
  let current: Type | undefined | null = type;
  while (current?.isTypeAlias?.()) {
    if (!current.type || seen.has(current)) return undefined;
    seen.add(current);
    current = current.type;
  }
  return current ?? undefined;
};

const typeKey = (type: Type, state: KeyState = createKeyState()): string => {
  const cached = state.memo.get(type);
  if (cached) return cached;

  const active = state.stack.get(type);
  if (active !== undefined) return `cycle:${active}`;

  const index = state.stack.size;
  state.stack.set(type, index);

  let key: string;

  if (type.isTypeAlias()) {
    const target = unwrapAlias(type);
    key = target ? typeKey(target, state) : `alias:${type.id}`;
  } else if (type.isPrimitiveType()) {
    key = `prim:${type.name.value}`;
  } else if (type.isSelfType()) {
    key = "self";
  } else if (type.isUnionType()) {
    const seen = new Set<string>();
    const parts = type.types
      .map((child) => typeKey(child, state))
      .filter((part) => {
        if (seen.has(part)) return false;
        seen.add(part);
        return true;
      })
      .sort();
    key = `union:[${parts.join("|")}]`;
  } else if (type.isIntersectionType()) {
    const parts = new Set<string>();
    if (type.nominalType)
      parts.add(`nom:${typeKey(type.nominalType, state)}`);
    if (type.structuralType)
      parts.add(`str:${typeKey(type.structuralType, state)}`);
    if (parts.size === 0) parts.add("empty");
    const ordered = Array.from(parts).sort();
    key = `intersection:[${ordered.join("|")}]`;
  } else if (type.isTupleType()) {
    const entries = type.value.map((child) => typeKey(child, state));
    key = `tuple:[${entries.join(",")}]`;
  } else if (type.isFixedArrayType()) {
    key = `fixed:${type.elemType ? typeKey(type.elemType, state) : "?"}`;
  } else if (type.isFnType()) {
    const params = type.parameters.map((param) => {
      const opt = param.isOptional ? "opt" : "req";
      const label = param.label ? param.label.value : "";
      const paramType = param.type ? typeKey(param.type, state) : "?";
      return `${opt}:${label}:${paramType}`;
    });
    const ret = type.returnType ? typeKey(type.returnType, state) : "void";
    key = `fn(${params.join(",")})=>${ret}`;
  } else if (type.isObjectType()) {
    if (type.genericParent) {
      const parentId = type.genericParent.id;
      const args = (type.appliedTypeArgs ?? []).map((arg) => {
        const target = unwrapAlias(arg) ?? arg;
        return target ? typeKey(target, state) : `alias:${arg.id}`;
      });
      key = `obj-gen:${parentId}<${args.join(",")}>`;
    } else if (type.isStructural) {
      const fieldKeys = type.fields
        .map((field) =>
          `${field.name}:${field.type ? typeKey(field.type, state) : "?"}`
        )
        .sort();
      const parentKey = type.parentObjType
        ? typeKey(type.parentObjType, state)
        : "base";
      key = `obj-struct:${parentKey}|{${fieldKeys.join(",")}}`;
    } else {
      key = `obj:${type.id}`;
    }
  } else if (type.isTraitType()) {
    if (type.genericParent) {
      const parentId = type.genericParent.id;
      const args = (type.appliedTypeArgs ?? []).map((arg) => {
        const target = unwrapAlias(arg) ?? arg;
        return target ? typeKey(target, state) : `alias:${arg.id}`;
      });
      key = `trait-gen:${parentId}<${args.join(",")}>`;
    } else {
      key = `trait:${type.id}`;
    }
  } else {
    const fallback = type as Type;
    key = `type:${fallback.id}`;
  }

  state.stack.delete(type);
  state.memo.set(type, key);
  return key;
};

class CanonicalTypeTable {
  #table = new Map<string, Type>();

  get(key: string): Type | undefined {
    return this.#table.get(key);
  }

  insert(key: string, type: Type): void {
    if (!this.#table.has(key)) {
      this.#table.set(key, type);
    }
  }
}

export const canonicalizeResolvedTypes = (module: VoydModule): VoydModule => {
  const table = new CanonicalTypeTable();
  const cache = new Map<Type, Type>();
  const finalized = new Set<Type>();
  const inProgress = new Set<Type>();
  const seenExprs = new Set<Expr>();
  const seenFns = new Set<Fn>();
  const seenClosures = new Set<Closure>();
  const seenImpls = new Set<Implementation>();
  const keyState = createKeyState();

  const mergeTypeMetadata = (source: Type, target: Type): Type => {
    if (source === target) return target;

    if (source.isObjectType() && target.isObjectType()) {
      if (source.typesResolved && !target.typesResolved) target.typesResolved = true;

      if (source.genericInstances?.length) {
        const seen = new Set(target.genericInstances ?? []);
        source.genericInstances.forEach((inst) => {
          if (seen.has(inst)) return;
          if (!target.genericInstances) target.genericInstances = [];
          target.genericInstances.push(inst);
          seen.add(inst);
        });
      }

      if (source.implementations?.length) {
        const seen = new Set(target.implementations);
        source.implementations.forEach((impl) => {
          if (seen.has(impl)) return;
          target.implementations.push(impl);
          seen.add(impl);
        });
      }
    } else if (source.isTraitType() && target.isTraitType()) {
      if (source.typesResolved && !target.typesResolved) target.typesResolved = true;

      if (source.genericInstances?.length) {
        const seen = new Set(target.genericInstances ?? []);
        source.genericInstances.forEach((inst) => {
          if (seen.has(inst)) return;
          if (!target.genericInstances) target.genericInstances = [];
          target.genericInstances.push(inst);
          seen.add(inst);
        });
      }

      if (source.implementations?.length) {
        const seen = new Set(target.implementations);
        source.implementations.forEach((impl) => {
          if (seen.has(impl)) return;
          target.implementations.push(impl);
          seen.add(impl);
        });
      }
    } else if (source.isUnionType() && target.isUnionType()) {
      target.resolutionPhase = Math.max(
        target.resolutionPhase ?? 0,
        source.resolutionPhase ?? 0
      );
    } else if (source.isTypeAlias() && target.isTypeAlias()) {
      target.resolutionPhase = Math.max(target.resolutionPhase, source.resolutionPhase);
      if (!target.type && source.type) target.type = source.type;
    }

    return target;
  };

  const canonicalizeAttributeType = (expr: Expr, key: string) => {
    const value = expr.getAttribute(key) as unknown;
    const maybeType = value as Type | undefined;
    if (maybeType?.isType?.()) {
      const canonical = rewriteType(maybeType);
      if (canonical) expr.setAttribute(key, canonical);
    }
  };

  const canonicalizeList = (list?: List) => {
    if (!list) return;
    for (let i = 0; i < list.length; i += 1) {
      const item = list.at(i);
      if (!item) continue;
      const canonical = canonicalizeExpr(item);
      if (canonical !== item) {
        list.set(i, canonical);
      }
    }
  };

  const canonicalizeParameter = (parameter: Parameter): Parameter => {
    parameter.type = rewriteType(parameter.type);
    parameter.originalType = rewriteType(parameter.originalType);
    if (parameter.typeExpr) {
      parameter.typeExpr = canonicalizeExpr(parameter.typeExpr);
    }
    return parameter;
  };

  const canonicalizeVariable = (variable: Variable): Variable => {
    variable.type = rewriteType(variable.type);
    variable.originalType = rewriteType(variable.originalType);
    variable.inferredType = rewriteType(variable.inferredType);
    variable.annotatedType = rewriteType(variable.annotatedType);
    if (variable.typeExpr) {
      variable.typeExpr = canonicalizeExpr(variable.typeExpr);
    }
    variable.initializer = canonicalizeExpr(variable.initializer);
    return variable;
  };

  const canonicalizeFn = (fn: Fn): Fn => {
    if (seenFns.has(fn)) return fn;
    seenFns.add(fn);
    fn.parameters.forEach(canonicalizeParameter);
    fn.variables.forEach(canonicalizeVariable);
    fn.returnType = rewriteType(fn.returnType);
    fn.inferredReturnType = rewriteType(fn.inferredReturnType);
    fn.annotatedReturnType = rewriteType(fn.annotatedReturnType);
    if (fn.returnTypeExpr) {
      fn.returnTypeExpr = canonicalizeExpr(fn.returnTypeExpr);
    }
    if (fn.body) {
      fn.body = canonicalizeExpr(fn.body);
    }
    if (fn.appliedTypeArgs) {
      fn.appliedTypeArgs = fn.appliedTypeArgs
        .map((arg) => rewriteType(arg))
        .filter((arg): arg is Type => !!arg);
    }
    fn.genericInstances?.forEach(canonicalizeFn);
    canonicalizeAttributeType(fn as unknown as Expr, "parameterFnType");
    return fn;
  };

  const canonicalizeClosure = (closure: Closure): Closure => {
    if (seenClosures.has(closure)) return closure;
    seenClosures.add(closure);
    closure.parameters.forEach(canonicalizeParameter);
    closure.variables.forEach(canonicalizeVariable);
    closure.captures.forEach((capture) => {
      if (capture.isVariable()) canonicalizeVariable(capture);
      else if (capture.isParameter()) canonicalizeParameter(capture);
    });
    closure.returnType = rewriteType(closure.returnType);
    closure.inferredReturnType = rewriteType(closure.inferredReturnType);
    closure.annotatedReturnType = rewriteType(closure.annotatedReturnType);
    if (closure.returnTypeExpr) {
      closure.returnTypeExpr = canonicalizeExpr(closure.returnTypeExpr);
    }
    closure.body = canonicalizeExpr(closure.body);
    canonicalizeAttributeType(closure, "parameterFnType");
    return closure;
  };

  const canonicalizeImplementation = (impl: Implementation): Implementation => {
    if (seenImpls.has(impl)) return impl;
    seenImpls.add(impl);
    impl.typeParams.each((id) => canonicalizeExpr(id));
    impl.targetType = rewriteType(impl.targetType);
    impl.trait = rewriteType(impl.trait) as TraitType | undefined;
    if (impl.targetTypeExpr.value) {
      impl.targetTypeExpr.value = canonicalizeExpr(impl.targetTypeExpr.value);
    }
    if (impl.traitExpr.value) {
      impl.traitExpr.value = canonicalizeExpr(impl.traitExpr.value);
    }
    impl.body.value = canonicalizeExpr(impl.body.value);
    impl.methods.forEach(canonicalizeFn);
    impl.exports.forEach(canonicalizeFn);
    return impl;
  };

  const finalizeObjectType = (type: ObjectType) => {
    type.fields.forEach((field) => {
      if (field.typeExpr) field.typeExpr = canonicalizeExpr(field.typeExpr);
      field.type = rewriteType(field.type);
    });
    if (type.parentObjExpr) {
      type.parentObjExpr = canonicalizeExpr(type.parentObjExpr);
    }
    const parent = rewriteType(type.parentObjType);
    type.parentObjType = parent?.isObjectType() ? parent : type.parentObjType;
    if (type.appliedTypeArgs) {
      type.appliedTypeArgs = type.appliedTypeArgs.map((arg) => {
        if (arg.isTypeAlias()) {
          arg.type = rewriteType(arg.type);
          if (arg.typeExpr) arg.typeExpr = canonicalizeExpr(arg.typeExpr);
          return arg;
        }
        const canonical = rewriteType(arg);
        return canonical ?? arg;
      });
    }
    if (type.genericParent) {
      const parentType = rewriteType(type.genericParent);
      type.genericParent = parentType?.isObjectType()
        ? parentType
        : type.genericParent;
    }
    if (type.genericInstances) {
      type.genericInstances = type.genericInstances.map((inst) => {
        const canonical = rewriteType(inst);
        return canonical?.isObjectType() ? canonical : inst;
      });
    }
    if (type.implementations) {
      type.implementations.forEach(canonicalizeImplementation);
    }
  };

  const finalizeTraitType = (type: TraitType) => {
    type.methods.each((fn) => canonicalizeFn(fn));
    if (type.appliedTypeArgs) {
      type.appliedTypeArgs = type.appliedTypeArgs.map((arg) => {
        if (arg.isTypeAlias()) {
          arg.type = rewriteType(arg.type);
          if (arg.typeExpr) arg.typeExpr = canonicalizeExpr(arg.typeExpr);
          return arg;
        }
        const canonical = rewriteType(arg);
        return canonical ?? arg;
      });
    }
    if (type.genericParent) {
      const parent = rewriteType(type.genericParent);
      type.genericParent = parent?.isTraitType() ? parent : type.genericParent;
    }
    if (type.genericInstances) {
      type.genericInstances = type.genericInstances.map((inst) => {
        const canonical = rewriteType(inst);
        return canonical?.isTraitType() ? canonical : inst;
      });
    }
    if (type.implementations) {
      type.implementations.forEach(canonicalizeImplementation);
    }
  };

  const finalizeUnionType = (type: UnionType) => {
    const members = type.types
      .map((child) => rewriteType(child))
      .filter((child): child is UnionType["types"][number] => !!child);
    const unique = new Set<UnionType["types"][number]>();
    type.types = members.filter((member) => {
      if (unique.has(member)) return false;
      unique.add(member);
      return true;
    });
  };

  const finalizeIntersectionType = (type: IntersectionType) => {
    const nominal = rewriteType(type.nominalType);
    type.nominalType = nominal?.isObjectType() ? nominal : undefined;
    const structural = rewriteType(type.structuralType);
    type.structuralType = structural?.isObjectType() ? structural : undefined;
  };

  const finalizeTupleType = (type: TupleType) => {
    type.value = type.value
      .map((child) => rewriteType(child))
      .filter((child): child is Type => !!child);
  };

  const finalizeFnType = (type: FnType) => {
    type.parameters.forEach(canonicalizeParameter);
    type.returnType = rewriteType(type.returnType);
  };

  const finalizeFixedArrayType = (type: FixedArrayType) => {
    type.elemType = rewriteType(type.elemType);
  };

  const finalizeType = (type: Type) => {
    if (finalized.has(type)) return;
    finalized.add(type);
    if (type.isTypeAlias()) {
      type.type = rewriteType(type.type);
      if (type.typeExpr) type.typeExpr = canonicalizeExpr(type.typeExpr);
      return;
    }
    if (type.isObjectType()) finalizeObjectType(type);
    else if (type.isTraitType()) finalizeTraitType(type);
    else if (type.isUnionType()) finalizeUnionType(type);
    else if (type.isIntersectionType()) finalizeIntersectionType(type);
    else if (type.isTupleType()) finalizeTupleType(type);
    else if (type.isFnType()) finalizeFnType(type);
    else if (type.isFixedArrayType()) finalizeFixedArrayType(type);
  };

  const rewriteType = (type: Type | undefined | null): Type | undefined => {
    if (!type) return undefined;
    const existing = cache.get(type);
    if (existing) return existing;

    if (type === voydBaseObject) {
      cache.set(type, type);
      return type;
    }

    if (type.isPrimitiveType() || type.isSelfType()) {
      cache.set(type, type);
      return type;
    }

    if (type.isTypeAlias()) {
      finalizeType(type);
      cache.set(type, type);
      return type;
    }

    if (inProgress.has(type)) return type;
    inProgress.add(type);
    finalizeType(type);
    inProgress.delete(type);

    const key = typeKey(type, keyState);
    const canonical = table.get(key);
    if (canonical) {
      mergeTypeMetadata(type, canonical);
      finalizeType(canonical);
      cache.set(type, canonical);
      return canonical;
    }

    table.insert(key, type);
    cache.set(type, type);
    return type;
  };

  const canonicalizeObjectLiteral = (literal: ObjectLiteral): ObjectLiteral => {
    literal.type = rewriteType(literal.type) as ObjectType | undefined;
    literal.fields.forEach((field) => {
      field.initializer = canonicalizeExpr(field.initializer);
      field.type = rewriteType(field.type);
    });
    return literal;
  };

  const canonicalizeMatch = (match: Match): Match => {
    match.operand = canonicalizeExpr(match.operand);
    match.type = rewriteType(match.type);
    match.baseType = rewriteType(match.baseType);
    if (match.bindVariable) canonicalizeVariable(match.bindVariable);
    match.cases.forEach((matchCase) => {
      if (matchCase.matchTypeExpr) {
        matchCase.matchTypeExpr = canonicalizeExpr(matchCase.matchTypeExpr);
      }
      const resolvedType = rewriteType(matchCase.matchType);
      matchCase.matchType = resolvedType?.isRefType?.()
        ? resolvedType
        : matchCase.matchType;
      matchCase.expr = canonicalizeExpr(matchCase.expr) as Block | Call;
    });
    if (match.defaultCase) {
      if (match.defaultCase.matchTypeExpr) {
        match.defaultCase.matchTypeExpr = canonicalizeExpr(
          match.defaultCase.matchTypeExpr
        );
      }
      const resolvedType = rewriteType(match.defaultCase.matchType);
      match.defaultCase.matchType = resolvedType?.isRefType?.()
        ? resolvedType
        : match.defaultCase.matchType;
      match.defaultCase.expr = canonicalizeExpr(
        match.defaultCase.expr
      ) as Block | Call;
    }
    match.bindIdentifier = canonicalizeExpr(match.bindIdentifier) as Identifier;
    return match;
  };

  const canonicalizeCall = (call: Call): Call => {
    call.fnName = canonicalizeExpr(call.fnName) as Identifier;
    canonicalizeList(call.args);
    if (call.typeArgs) canonicalizeList(call.typeArgs);
    call.type = rewriteType(call.type);
    canonicalizeAttributeType(call, "expectedType");
    canonicalizeAttributeType(call, "parameterFnType");
    if (call.fn?.isFn()) canonicalizeFn(call.fn);
    if (call.fn?.isObjectType()) call.fn = rewriteType(call.fn) as ObjectType;
    return call;
  };

  const canonicalizeExpr = (expr: Expr): Expr => {
    if (seenExprs.has(expr)) return expr;
    seenExprs.add(expr);

    if (expr.isModule()) {
      expr.applyMap((child) => canonicalizeExpr(child));
      return expr;
    }

    if (expr.isBlock()) {
      expr.applyMap((child) => canonicalizeExpr(child));
      expr.type = rewriteType(expr.type);
      return expr;
    }

    if (expr.isCall()) return canonicalizeCall(expr);
    if (expr.isFn()) return canonicalizeFn(expr);
    if (expr.isClosure()) return canonicalizeClosure(expr);
    if (expr.isVariable()) return canonicalizeVariable(expr);
    if (expr.isParameter()) return canonicalizeParameter(expr);
    if (expr.isIdentifier()) {
      expr.type = rewriteType(expr.type);
      return expr;
    }
    if (expr.isObjectLiteral()) return canonicalizeObjectLiteral(expr);
    if (expr.isArrayLiteral()) {
      expr.elements = expr.elements.map((element) => canonicalizeExpr(element));
      return expr;
    }
    if (expr.isMatch()) return canonicalizeMatch(expr);
    if (expr.isImpl()) return canonicalizeImplementation(expr);
    if (expr.isTraitType()) return rewriteType(expr) as TraitType;
    if (expr.isObjectType()) return rewriteType(expr) as ObjectType;
    if (expr.isUnionType()) return rewriteType(expr) as UnionType;
    if (expr.isIntersectionType())
      return rewriteType(expr) as IntersectionType;
    if (expr.isFixedArrayType()) return rewriteType(expr) as FixedArrayType;
    if (expr.isTupleType()) return rewriteType(expr) as TupleType;
    if (expr.isFnType()) return rewriteType(expr) as FnType;
    if (expr.isTypeAlias()) {
      finalizeType(expr);
      return expr;
    }
    if (expr.isGlobal()) {
      canonicalizeExpr(expr.initializer);
      const globalType = rewriteType(expr.type);
      if (globalType) (expr as unknown as { type: Type }).type = globalType;
      return expr;
    }
    if (expr.isDeclaration()) {
      expr.fns.forEach(canonicalizeFn);
      return expr;
    }
    if (expr.isList()) {
      canonicalizeList(expr);
      return expr;
    }

    return expr;
  };

  canonicalizeExpr(module);
  return module;
};

export const canonicalizeTypesPhase = (expr: Expr): Expr => {
  if (expr.isModule()) canonicalizeResolvedTypes(expr);
  return expr;
};

export type CanonicalizeTypesFn = typeof canonicalizeResolvedTypes;

