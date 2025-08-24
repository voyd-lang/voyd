import { Call, Expr, Fn, Parameter } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { formatFnSignature } from "../fn-signature.js";
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

  const unfilteredCandidates = candidateFns ?? getCandidates(call);
  const candidates = filterCandidates(call, unfilteredCandidates);

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];

  const argTypes = call.args
    .toArray()
    .map((arg) => getExprType(arg)?.name.value)
    .join(", ");
  const signatures = candidates.map(formatFnSignature).join(", ");
  throw new Error(
    `Ambiguous call ${call.fnName}(${argTypes}) at ${call.location}. Candidates: ${signatures}`
  );
};

const getCandidates = (call: Call): Fn[] => {
  const fns = call.resolveFns(call.fnName);

  // Check for methods of arg 1
  const arg1 = call.argAt(0);
  const arg1Type =
    arg1?.isClosure() && arg1.parameters.some((p) => !p.type && !p.typeExpr)
      ? undefined
      : getExprType(arg1);

  if (arg1Type?.isObjectType()) {
    const isInsideImpl = call.parentImpl?.targetType?.id === arg1Type.id;
    const implFns = isInsideImpl
      ? [] // internal methods already in scope
      : arg1Type.implementations
          ?.flatMap((impl) =>
            // Trait implementations expose all methods, even when not
            // explicitly exported.  Non-trait implementations continue to
            // expose only their public exports.
            impl.trait ? impl.methods : impl.exports
          )
          .filter((fn) => fn.name.is(call.fnName.value));
    fns.push(...(implFns ?? []));
  }

  if (arg1Type?.isTraitType()) {
    const implFns = arg1Type.implementations
      ?.flatMap((impl) => impl.methods)
      .filter((fn) => fn.name.is(call.fnName.value));
    fns.push(...(implFns ?? []));
  }

  return fns;
};

const filterCandidates = (call: Call, candidates: Fn[]): Fn[] =>
  candidates.flatMap((candidate) => {
    if (candidate.typeParameters) {
      return filterCandidateWithGenerics(call, candidate);
    }

    // Resolve the function signature to check parameter compatibility without
    // resolving the body yet. This avoids prematurely resolving functions that
    // may depend on generic instances which have not been created at this
    // point in the compilation process (e.g. trait implementations for
    // specific type arguments).
    resolveFnSignature(candidate);

    if (parametersMatch(candidate, call) && typeArgsMatch(call, candidate)) {
      // Only fully resolve the function once we've determined that it matches
      // the call. This ensures that dependent generic instances are available
      // and prevents resolution from mutating functions that ultimately aren't
      // invoked.
      resolveFn(candidate);
      return candidate;
    }

    return [];
  });

const filterCandidateWithGenerics = (call: Call, candidate: Fn): Fn[] => {
  // Resolve generics
  if (!candidate.genericInstances) resolveFn(candidate, call);

  // Fn not compatible with call
  if (!candidate.genericInstances?.length) return [];

  // First attempt
  const genericsInstances = filterCandidates(call, candidate.genericInstances);

  // If we have instances, return them
  if (genericsInstances.length) return genericsInstances;

  // If no instances, attempt to resolve generics with this call, as a compatible instance
  // is still possible
  const beforeLen = candidate.genericInstances.length;
  resolveFn(candidate, call);
  const afterLen = candidate.genericInstances.length;

  if (beforeLen === afterLen) {
    // No new instances were created, so this call is not compatible
    return [];
  }

  return filterCandidates(call, candidate.genericInstances);
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
  paramsDirectlyMatch(candidate, call) ||
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
  if (labeledParams.length !== candidate.parameters.length) return false;

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
