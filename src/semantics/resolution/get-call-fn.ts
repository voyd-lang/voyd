import { Call, Expr, Fn } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const getCallFn = (call: Call): Fn | undefined => {
  if (isPrimitiveFnCall(call)) return undefined;

  const unfilteredCandidates = getCandidates(call);
  const candidates = filterCandidates(call, unfilteredCandidates);

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];

  throw new Error(
    `Ambiguous call ${JSON.stringify(call, null, 2)} at ${call.location}`
  );
};

const getCandidates = (call: Call): Fn[] => {
  const fns = call.resolveFns(call.fnName);

  // Check for methods of arg 1
  const arg1Type = getExprType(call.argAt(0));
  if (arg1Type?.isObjectType()) {
    const isInsideImpl = call.parentImpl?.targetType?.id === arg1Type.id;
    const implFns = isInsideImpl
      ? [] // internal methods already in scope
      : arg1Type.implementations
          ?.flatMap((impl) => impl.exports)
          .filter((fn) => fn.name.is(call.fnName.value));
    fns.push(...(implFns ?? []));
  }

  if (arg1Type?.isTraitType()) {
    const implFns = arg1Type.implementations
      ?.flatMap((impl) => impl.exports)
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

    resolveFn(candidate);
    return parametersMatch(candidate, call) && typeArgsMatch(call, candidate)
      ? candidate
      : [];
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
        return typesAreCompatible(argType, appliedType, {
          exactNominalMatch: true,
        });
      })
    : true;

const parametersMatch = (candidate: Fn, call: Call) => {
  // First attempt a direct positional/label match
  const directMatch = candidate.parameters.every((p, i) => {
    const arg = call.argAt(i);
    if (!arg) return false;
    const argType = getExprType(arg);
    if (!argType) return false;
    const argLabel = getExprLabel(arg);
    const labelsMatch = p.label?.value === argLabel;
    return typesAreCompatible(argType, p.type!) && labelsMatch;
  });
  if (directMatch) return true;

  // Special case: a single object argument supplying all labeled parameters
  if (call.args.length === 1) {
    const objArg = call.argAt(0);
    const objType = getExprType(objArg);
    if (objType?.isObjectType()) {
      const labeledParams = candidate.parameters.filter((p) => p.label);
      if (
        labeledParams.length === candidate.parameters.length &&
        labeledParams.every((p) => objType.hasField(p.label!.value))
      ) {
        return labeledParams.every((p) => {
          const field = objType.getField(p.label!.value);
          return field
            ? typesAreCompatible(field.type, p.type!)
            : false;
        });
      }
    }
  }

  return false;
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
