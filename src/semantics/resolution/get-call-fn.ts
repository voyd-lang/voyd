import { Call, Expr, Fn, Parameter, Type } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { formatFnSignature } from "../fn-signature.js";
import { formatTypeName } from "../type-format.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveFn, resolveFnSignature } from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { resolveEntities } from "./resolve-entities.js";

export const getCallFn = (call: Call, candidateFns?: Fn[]): Fn | undefined => {
  if (call.fn?.isFn() && call.fn.parentTrait) return resolveFn(call.fn);
  if (isPrimitiveFnCall(call)) return undefined;

  const candidates = getAllCandidates(call, candidateFns);
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];

  const result =
    selectByExplicitTypeArgs(call, candidates) ??
    selectByExpectedReturnType(call, candidates) ??
    selectByConcreteReturn(candidates) ??
    selectReturnCovering(candidates) ??
    selectArgCovering(candidates);

  return result ?? throwAmbiguous(call, candidates);
};

const getAllCandidates = (call: Call, candidateFns?: Fn[]): Fn[] => {
  const base = candidateFns ?? getCandidates(call);
  const expanded = expandGenericCandidates(call, base);
  return dedupeCandidates(filterResolvedCandidates(call, expanded));
};

const selectByExplicitTypeArgs = (
  call: Call,
  candidates: Fn[]
): Fn | undefined => {
  if (!call.typeArgs) return;
  const appliedExact = candidates.filter((cand) =>
    cand.appliedTypeArgs?.every((t, i) => {
      const arg = call.typeArgs!.at(i);
      if (arg) resolveTypeExpr(arg);
      const argType = getExprType(arg);
      const appliedType = getExprType(t);
      return typesAreEqual(argType, appliedType);
    })
  );
  if (appliedExact.length === 1) return appliedExact[0];
  if (appliedExact.length > 1) {
    const specialized = appliedExact.filter((c) => !!c.appliedTypeArgs);
    if (specialized.length === 1) return specialized[0];
  }
  return undefined;
};

const unwrapAlias = (t: Type): Type => (t.isTypeAlias?.() ? t.type ?? t : t);

const selectByExpectedReturnType = (
  call: Call,
  candidates: Fn[]
): Fn | undefined => {
  const expected =
    call.getAttribute &&
    (call.getAttribute("expectedType") as Type | undefined);
  if (!expected) return;

  const headKeyFromType = (t: Type | undefined): string | undefined => {
    const u = t ? unwrapAlias(t) : undefined;
    if (!u) return undefined;
    if (u.isObjectType && u.isObjectType())
      return u.genericParent ? u.genericParent.name.value : u.name.value;
    if (u.isPrimitiveType && u.isPrimitiveType()) return u.name.value;
    if (u.isTraitType && u.isTraitType()) return u.name.value;
    if (u.isFixedArrayType && u.isFixedArrayType()) return "FixedArray";
    if (u.isIntersectionType && u.isIntersectionType())
      return headKeyFromType(u.nominalType ?? u.structuralType);
    if (u.isTypeAlias && u.isTypeAlias()) return headKeyFromType(u.type);
    return u.name?.value;
  };

  const expectedBranch =
    expected.isUnionType && expected.isUnionType()
      ? (() => {
          const heads = new Set(
            candidates
              .map((c) => headKeyFromType(c.returnType))
              .filter((h): h is string => !!h)
          );
          const single = heads.size === 1 ? [...heads][0] : undefined;
          return single
            ? expected.types.find((t) => headKeyFromType(t) === single)
            : undefined;
        })()
      : expected;

  if (!expectedBranch) return;

  const exact = candidates.filter((c) =>
    typesAreEqual(c.returnType, expectedBranch)
  );
  if (exact.length === 1) return exact[0];

  const rank = (ret: Type | undefined): number => {
    if (typesAreEqual(ret, expectedBranch)) return 3;
    if (ret && typesAreCompatible(ret, expectedBranch)) {
      const head = headKeyFromType(ret);
      const expHead = headKeyFromType(expectedBranch);
      if (
        head &&
        expHead &&
        head === expHead &&
        ret.isObjectType?.() &&
        expectedBranch.isObjectType?.()
      ) {
        const ra = (ret.appliedTypeArgs ?? []).map(unwrapAlias);
        const ea = (expectedBranch.appliedTypeArgs ?? []).map(unwrapAlias);
        if (ra.length === ea.length && ra.every((t, i) => typesAreEqual(t, ea[i])))
          return 2;
      }
      return 1;
    }
    return 0;
  };

  let best: Fn[] = [];
  let bestScore = -1;
  for (const c of candidates) {
    const score = rank(c.returnType);
    if (score > bestScore) {
      best = [c];
      bestScore = score;
    } else if (score === bestScore) {
      best.push(c);
    }
  }
  return bestScore > 0 && best.length === 1 ? best[0] : undefined;
};

const selectByConcreteReturn = (candidates: Fn[]): Fn | undefined => {
  const concreteReturn = candidates.filter((c) => {
    const ret = formatTypeName(c.returnType);
    const applied = (c.appliedTypeArgs ?? []).map((a) => formatTypeName(a));
    return !applied.some((name) => ret.includes(`<${name}>`) || ret === name);
  });
  return concreteReturn.length === 1 ? concreteReturn[0] : undefined;
};

const toBranches = (t: Type): Type[] => {
  const u = unwrapAlias(t);
  return u.isUnionType?.() ? u.types : [u];
};

const covers = (a?: Type, b?: Type): boolean => {
  if (!a || !b) return false;
  const aBranches = toBranches(a);
  const bBranches = toBranches(b);
  return bBranches.every((bt) => aBranches.some((at) => typesAreEqual(at, bt)));
};

const selectReturnCovering = (candidates: Fn[]): Fn | undefined => {
  const covering = candidates.filter((c) =>
    candidates.every((o) => c === o || covers(c.returnType, o.returnType))
  );
  return covering.length === 1 ? covering[0] : undefined;
};

const selectArgCovering = (candidates: Fn[]): Fn | undefined => {
  const argCovering = candidates.filter((c) =>
    candidates.every((o) =>
      c === o ||
      c.parameters.every((p, i) => covers(p.type, o.parameters[i]?.type))
    )
  );
  return argCovering.length === 1 ? argCovering[0] : undefined;
};

const throwAmbiguous = (call: Call, candidates: Fn[]): never => {
  const argTypes = call.args
    .toArray()
    .map((arg) => formatTypeName(getExprType(arg)))
    .join(", ");
  const signatures = candidates.map(formatFnSignature).join(", ");
  throw new Error(
    `Ambiguous call ${call.fnName}(${argTypes}) at ${call.location}. Candidates: ${signatures}`
  );
};

const getCandidates = (call: Call): Fn[] => {
  let fns = call.resolveFns(call.fnName);

  // Check for methods of arg 1
  const arg1 = call.argAt(0);
  const arg1Type =
    arg1?.isClosure() && arg1.parameters.some((p) => !p.type && !p.typeExpr)
      ? undefined
      : getExprType(arg1);

  if (arg1Type?.isObjectType()) {
    const isInsideImpl = call.parentImpl?.targetType?.id === arg1Type.id;
    const arg0 = call.argAt(0);
    const isObjectArgForm = !!(arg0 && arg0.isCall() && arg0.calls(":"));
    const implFns = arg1Type.implementations
      ?.flatMap((impl) => {
        // Include both exported methods and internal methods so resolution
        // works regardless of export mechanics or ordering
        const methods: Fn[] = [];
        methods.push(...impl.exports);
        // Some implementations (non-trait) may not register exports for `pub fn`
        // early; include impl.methods as well to avoid timing holes.
        impl.methods.forEach((m) => methods.push(m));
        return methods;
      })
      .filter((fn) => fn.name.is(call.fnName.value))
      // When inside an impl body, its methods are already in lexical scope via
      // pre-registration. Avoid duplicate candidates from the same impl.
      .filter((fn) =>
        isInsideImpl ? fn.parentImpl !== call.parentImpl : true
      );
    if (implFns && implFns.length && !isObjectArgForm) {
      // Prefer receiver methods in method-call position. When arg1 is an
      // object type and we are not using object-arg form, restrict candidates
      // to only the receiver's methods. This avoids ambiguity with generic
      // instances from other scopes whose `self` type hasn't been specialized.
      fns = [...implFns];
    } else if (implFns && implFns.length) {
      // In object-arg form (labeled params), don't drop top-level functions;
      // include both so labeled-arg overloads can match.
      fns.push(...implFns);
    }
  }

  if (arg1Type?.isTraitType()) {
    const implFns = arg1Type.implementations
      ?.flatMap((impl) => impl.exports)
      .filter((fn) => fn.name.is(call.fnName.value));
    fns.push(...(implFns ?? []));
  }

  return fns;
};

const dedupeCandidates = (fns: Fn[]): Fn[] => {
  const unique = new Map<string, Fn>();
  fns.forEach((fn) => {
    const key = `${fn.location?.toString() ?? fn.id}:${formatFnSignature(fn)}`;
    if (!unique.has(key)) unique.set(key, fn);
  });
  return [...unique.values()];
};

const expandGenericCandidates = (call: Call, candidates: Fn[]): Fn[] => {
  const out: Fn[] = [];
  for (const c of candidates) {
    if (!c.typeParameters) {
      out.push(c);
      continue;
    }
    // Attempt to specialize generics with this call to surface compatible instances
    resolveFn(c, call);
    if (c.genericInstances?.length) out.push(...c.genericInstances);
  }
  return out;
};

const filterResolvedCandidates = (call: Call, candidates: Fn[]): Fn[] => {
  return candidates.flatMap((candidate) => {
    // Resolve the function signature to check parameter compatibility without
    // resolving the body yet.
    resolveFnSignature(candidate);

    if (parametersMatch(candidate, call) && typeArgsMatch(call, candidate)) {
      // Now fully resolve since we will use it
      resolveFn(candidate);
      return candidate;
    }
    return [];
  });
};

const typeArgsMatch = (call: Call, candidate: Fn): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const arg = call.typeArgs?.at(i);
        if (arg) resolveTypeExpr(arg);
        const argType = getExprType(arg);
        const appliedType = getExprType(t);
        return typesAreEqual(argType, appliedType);
      })
    : true;

const parametersMatch = (candidate: Fn, call: Call) =>
  (call.args.length <= candidate.parameters.length &&
    paramsDirectlyMatch(candidate, call)) ||
  objectArgSuppliesLabeledParams(candidate, call);

const paramsDirectlyMatch = (candidate: Fn, call: Call) => {
  let argIndex = 0;
  return candidate.parameters.every((p) => {
    const arg = call.argAt(argIndex);
    if (!arg)
      return p.typeExpr?.isCall() && p.typeExpr.fnName.is("Optional");
    const argLabel = getExprLabel(arg);
    if (argLabel && argLabel !== p.label?.value)
      return p.typeExpr?.isCall() && p.typeExpr.fnName.is("Optional");
    const matches = argumentMatchesParam(call, p, argIndex);
    if (matches) argIndex++;
    return matches;
  });
};

const argumentMatchesParam = (
  call: Call,
  param: Parameter,
  index: number
): boolean => {
  const arg = call.argAt(index);
  if (!arg) return false;

  const val = arg.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
  if (
    val?.isClosure() &&
    val.parameters.some((cp) => !cp.type && !cp.typeExpr)
  ) {
    const paramType = param.type;
    if (!paramType?.isFnType()) return false;
    val.parameters.forEach((cp, j) => {
      const expected = paramType.parameters[j]?.type;
      if (!cp.type && expected) cp.type = expected;
    });
    const resolvedVal = resolveEntities(val);
    if (arg.isCall() && arg.calls(":")) arg.args.set(1, resolvedVal);
    else call.args.set(index, resolvedVal);
  }

  const argType = getExprType(val);
  if (!argType) return false;
  const argLabel = getExprLabel(arg);
  const labelsMatch = param.label?.value === argLabel;
  if (
    param.typeExpr?.isCall() &&
    param.typeExpr.fnName.is("Optional") &&
    typesAreCompatible(argType, getExprType(param.typeExpr.typeArgs?.at(0)))
  ) {
    return labelsMatch;
  }
  return typesAreCompatible(argType, param.type!) && labelsMatch;
};

const objectArgSuppliesLabeledParams = (candidate: Fn, call: Call): boolean => {
  if (call.args.length !== 1) return false;
  const objArg = call.argAt(0);
  const labeledParams = candidate.parameters.filter((p) => p.label);
  if (
    labeledParams.length === 0 ||
    labeledParams.length !== candidate.parameters.length
  )
    return false;

  if (objArg?.isObjectLiteral()) {
    return labeledParams.every((p) => {
      const field = objArg.fields.find((f) => f.name === p.label!.value);
      if (!field)
        return p.typeExpr?.isCall() && p.typeExpr.fnName.is("Optional");
      const fieldType = getExprType(field.initializer);
      return typesAreCompatible(fieldType, p.type!);
    });
  }

  const objType = getExprType(objArg);
  const structType = objType?.isObjectType()
    ? objType
    : objType?.isIntersectionType()
    ? objType.structuralType
    : undefined;
  if (!structType) return false;
  if (
    labeledParams.some(
      (p) =>
        !structType.hasField(p.label!.value) &&
        !(p.typeExpr?.isCall() && p.typeExpr.fnName.is("Optional"))
    )
  )
    return false;
  return labeledParams.every((p) => {
    const field = structType.getField(p.label!.value);
    if (!field) return true;
    return typesAreCompatible(field.type, p.type!);
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!expr?.isCall()) return undefined;
  if (!expr.calls(":")) return undefined;
  const id = expr.argAt(0);
  if (id?.isIdentifier()) return id.value;
  return undefined;
};

const isPrimitiveFnCall = (call: Call): boolean => {
  const name = call.fnName.value;
  return (
    name === "export" ||
    name === "if" ||
    name === "return" ||
    name === "binaryen" ||
    name === ":" ||
    name === "=" ||
    name === "while" ||
    name === "for" ||
    name === "break" ||
    name === "mod" ||
    name === "continue" ||
    name === "::"
  );
};

