import { Call, Expr, Fn, Parameter } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { formatFnSignature } from "../fn-signature.js";
import { formatTypeName } from "../type-format.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveFn, resolveFnSignature } from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { resolveEntities } from "./resolve-entities.js";

export const getCallFn = (call: Call, candidateFns?: Fn[]): Fn | undefined => {
  if (call.fn?.isFn() && call.fn.parentTrait) {
    return resolveFn(call.fn);
  }

  if (isPrimitiveFnCall(call)) return undefined;

  const baseCandidates = candidateFns ?? getCandidates(call);
  const expanded = expandGenericCandidates(call, baseCandidates);
  const candidates = dedupeCandidates(filterResolvedCandidates(call, expanded));

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];

  // Tie-break using contextual expected return type if available. Prefer the
  // candidate whose return type exactly matches the expected branch (by
  // nominal head) when the expected type is a union alias like MsgPack.
  const expected =
    call.getAttribute && (call.getAttribute("expectedType") as any);
  if (expected) {
    const headKeyFromType = (t: any): string | undefined => {
      if (!t) return undefined;
      if (t.isObjectType && t.isObjectType()) {
        return t.genericParent ? t.genericParent.name.value : t.name.value;
      }
      if (t.isPrimitiveType && t.isPrimitiveType()) return t.name.value;
      if (t.isTraitType && t.isTraitType()) return t.name.value;
      if (t.isFixedArrayType && t.isFixedArrayType()) return "FixedArray";
      if (t.isIntersectionType && t.isIntersectionType())
        return headKeyFromType(t.nominalType ?? t.structuralType);
      if (t.isTypeAlias && t.isTypeAlias()) return headKeyFromType(t.type);
      return t.name?.value;
    };
    const expectedBranch = (() => {
      if (expected.isUnionType && expected.isUnionType()) {
        // Pick branch matching candidate head if all candidates share the same head
        const heads = new Set(
          candidates
            .map((c) => headKeyFromType(c.returnType))
            .filter((h): h is string => !!h)
        );
        const single = heads.size === 1 ? [...heads][0] : undefined;
        return single
          ? expected.types.find((t: any) => headKeyFromType(t) === single)
          : undefined;
      }
      return expected;
    })();
    if (expectedBranch) {
      const exact = candidates.filter((c) =>
        typesAreEqual(c.returnType, expectedBranch)
      );
      if (exact.length === 1) return exact[0];

      // Rank candidates by closeness to expected branch.
      const rank = (ret: any): number => {
        if (typesAreEqual(ret, expectedBranch)) return 3;
        if (typesAreCompatible(ret, expectedBranch)) {
          // When both are Array<...> or the same nominal head, prefer the one
          // whose applied type arguments exactly match the expected branch's
          // applied type arguments.
          const head = headKeyFromType(ret);
          const expHead = headKeyFromType(expectedBranch);
          if (
            head &&
            expHead &&
            head === expHead &&
            ret.isObjectType?.() &&
            expectedBranch.isObjectType?.()
          ) {
            const ra = (ret.appliedTypeArgs ?? []).map((a: any) => a.type ?? a);
            const ea = (expectedBranch.appliedTypeArgs ?? []).map(
              (a: any) => a.type ?? a
            );
            if (
              ra.length === ea.length &&
              ra.every((t: any, i: number) => typesAreEqual(t, ea[i]))
            )
              return 2;
          }
          return 1;
        }
        return 0;
      };
      let best: Fn | undefined;
      let bestScore = -1;
      for (const c of candidates) {
        const score = rank(c.returnType);
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      if (best && bestScore > 0) return best;
    }
  }

  // Heuristic: when multiple specialized instances remain and they differ
  // only by whether the return type still references a generic placeholder
  // (e.g., Array<O> vs Array<MsgPack>), prefer the one with a concrete
  // (non-placeholder) return type.
  const concreteReturn = candidates.filter((c) => {
    const ret = formatTypeName(c.returnType);
    const applied = (c.appliedTypeArgs ?? []).map((a) => formatTypeName(a));
    // If any applied type alias name remains verbatim in the return type, treat it as genericy
    // TODO: There has got to be a better way to do this. Maybe we mark identifiers as generic type params or something in the attribute
    return !applied.some((name) => ret.includes(`<${name}>`) || ret === name);
  });
  if (concreteReturn.length === 1) return concreteReturn[0];

  // Fallback heuristic: prefer the candidate with the most specific (longest)
  // formatted return type. This biases toward concretely-applied generics like
  // Array<MsgPack> over Array<O> when other tie-breakers fail.
  const bySpecificity = [...candidates].sort((a, b) =>
    formatTypeName(a.returnType).length - formatTypeName(b.returnType).length
  );
  const mostSpecific = bySpecificity.at(-1);
  const next = bySpecificity.at(-2);
  if (
    mostSpecific &&
    (!next ||
      formatTypeName(mostSpecific.returnType).length >
        formatTypeName(next.returnType).length)
  ) {
    return mostSpecific;
  }

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
  (call.args.length === candidate.parameters.length &&
    paramsDirectlyMatch(candidate, call)) ||
  objectArgSuppliesLabeledParams(candidate, call);

const paramsDirectlyMatch = (candidate: Fn, call: Call) =>
  candidate.parameters.every((p, i) => argumentMatchesParam(call, p, i));

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
      if (!field) return false;
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
  if (!labeledParams.every((p) => structType.hasField(p.label!.value)))
    return false;
  return labeledParams.every((p) => {
    const field = structType.getField(p.label!.value);
    return field ? typesAreCompatible(field.type, p.type!) : false;
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
