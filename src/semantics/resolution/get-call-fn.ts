import { Call, Expr, Fn, Identifier, Parameter } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { formatFnSignature } from "../fn-signature.js";
import { formatTypeName } from "../type-format.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { typesAreEqual } from "./types-are-equal.js";
import {
  resolveFn,
  resolveFnSignature,
  inferCallTypeArgs,
  resolveGenericsWithTypeArgsSignatureOnly,
} from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { resolveEntities } from "./resolve-entities.js";

export const getCallFn = (call: Call, candidateFns?: Fn[]): Fn | undefined => {
  if (call.fn?.isFn() && call.fn.parentTrait) {
    return resolveFn(call.fn);
  }

  if (isPrimitiveFnCall(call)) return undefined;

  const baseCandidates = candidateFns ?? getCandidates(call);
  const useSigOnly =
    process.env.VOYD_LAZY_FN_EXPANSION === "1" ||
    process.env.VOYD_LAZY_FN_EXPANSION === "true";

  const expanded = useSigOnly
    ? expandGenericCandidatesSignatureOnly(call, baseCandidates)
    : expandGenericCandidates(call, baseCandidates);

  let candidates = dedupeCandidates(filterResolvedCandidates(call, expanded));

  // Fallback: if the flag is on but produced no candidates, try full expansion
  if (useSigOnly && !candidates.length) {
    const full = expandGenericCandidates(call, baseCandidates);
    candidates = dedupeCandidates(filterResolvedCandidates(call, full));
  }

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];

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
      .filter((fn) => (isInsideImpl ? fn.parentImpl !== call.parentImpl : true));
    if (implFns && implFns.length && !isObjectArgForm) {
      // Prefer receiver methods over same-named top-level functions in
      // method-call position (arg1 is an object type). Drop non-method
      // candidates to avoid ambiguity.
      fns = fns.filter((fn) => !!fn.parentImpl);
      fns.push(...implFns);
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
        // If the call supplies a bare type-parameter identifier (e.g. `T`) and
        // the candidate applied type is an alias with the same name, consider
        // them a match even if no concrete Type has been bound yet.
        if (
          !argType &&
          arg?.isIdentifier?.() &&
          appliedType?.isTypeAlias() &&
          appliedType.name.is(arg as Identifier)
        )
          return true;
        return typesAreEqual(argType, appliedType);
      })
    : true;

const parametersMatch = (candidate: Fn, call: Call) =>
  (call.args.length === candidate.parameters.length &&
    paramsDirectlyMatch(candidate, call)) ||
  objectArgSuppliesLabeledParams(candidate, call);

const paramsDirectlyMatch = (candidate: Fn, call: Call) =>
  candidate.parameters.every((p, i) =>
    argumentMatchesParam(call, p, i)
  );

const argumentMatchesParam = (
  call: Call,
  param: Parameter,
  index: number
): boolean => {
  const arg = call.argAt(index);
  if (!arg) return false;

  const val = arg.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
  if (val?.isClosure() && val.parameters.some((cp) => !cp.type && !cp.typeExpr)) {
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
  const structType =
    objType?.isObjectType()
      ? objType
      : objType?.isIntersectionType()
      ? objType.structuralType
      : undefined;
  if (!structType) return false;
  if (!labeledParams.every((p) => structType.hasField(p.label!.value))) return false;
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

// Create signature-only instances for generic candidates using either explicit
// type-args on the call or inference from parameter types. Avoids resolving
// function bodies during candidate discovery.
const expandGenericCandidatesSignatureOnly = (
  call: Call,
  candidates: Fn[]
): Fn[] => {
  const out: Fn[] = [];
  for (const c of candidates) {
    if (!c.typeParameters) {
      out.push(c);
      continue;
    }
    const args = call.typeArgs ?? inferCallTypeArgs(c, call);
    if (args) {
      resolveGenericsWithTypeArgsSignatureOnly(c, args);
      if (c.genericInstances?.length) out.push(...c.genericInstances);
      else out.push(c);
      continue;
    }
    out.push(c);
  }
  return out;
};

// Signature-only expansion intentionally not used here to avoid risking
// under-specified type-arg contexts; full specialization handles enumeration.
