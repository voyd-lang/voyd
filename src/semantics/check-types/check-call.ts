import { Call } from "../../syntax-objects/call.js";
import { ObjectLiteral, bool } from "../../syntax-objects/index.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { getCallFn } from "../resolution/get-call-fn.js";
import { resolveUnionType } from "../resolution/resolve-union.js";
import { formatFnSignature } from "../fn-signature.js";

import { checkTypes } from "./check-types.js";
import { checkAssign } from "./check-assign.js";
import { checkIf } from "./check-if.js";
import { checkBinaryenCall } from "./check-binaryen-call.js";
import { checkLabeledArg } from "./check-labeled-arg.js";
import { checkFixedArrayType } from "./check-fixed-array-type.js";

export const checkCallTypes = (call: Call): Call | ObjectLiteral => {
  if (call.calls("export")) return checkExport(call);
  if (call.calls("if")) return checkIf(call);
  if (call.calls("call-closure")) return checkClosureCall(call);
  if (call.calls("binaryen")) return checkBinaryenCall(call);
  if (call.calls("mod")) return call;
  if (call.calls("break")) return call;
  if (call.calls(":")) return checkLabeledArg(call);
  if (call.calls("=")) return checkAssign(call);
  if (call.calls("while")) return checkWhile(call);
  if (call.calls("FixedArray")) return checkFixedArrayInit(call);
  if (call.calls("member-access")) return checkMemberAccess(call);
  if (call.fn?.isObjectType()) return checkObjectInit(call);

  call.args = call.args.map(checkTypes);

  if (!call.fn) {
    const arg1Type = getExprType(call.argAt(0));
    if (arg1Type?.isTraitType() && call.type) {
      // Trait method call may not have a concrete implementation yet
      return call;
    }
    // Not having a fn is ok when the call points to a closure. TODO: Make this more explicit on the call
    const entity = call.fnName.resolve();
    if (
      (entity?.isVariable() || entity?.isParameter()) &&
      entity.type?.isFnType()
    ) {
      return call;
    }

    const params = call.args
      .toArray()
      .map((arg) => getExprType(arg)?.name.value)
      .join(", ");

    const location = call.location ?? call.fnName.location;
    const candidates = call.resolveFns(call.fnName);
    if (candidates.length) {
      const signatures = candidates.map(formatFnSignature).join(", ");
      throw new Error(
        `No overload matches ${call.fnName}(${params}) at ${location}. Available overloads: ${signatures}`
      );
    }

    throw new Error(
      `Could not resolve fn ${call.fnName}(${params}) at ${location}`
    );
  }

  if (call.fn?.parent?.isTrait?.()) {
    try {
      const resolved = getCallFn(call);
      if (resolved) {
        call.fn = resolved;
        call.type = resolved.returnType;
      }
    } catch {}
  }

  if (!call.type) {
    throw new Error(
      `Could not resolve type for call ${call.fnName} at ${call.location}`
    );
  }

  return call;
};

const checkClosureCall = (call: Call): Call => {
  call.args = call.args.map(checkTypes);
  const closure = call.argAt(0);
  const closureType = getExprType(closure);
  if (!closureType?.isFnType()) {
    throw new Error(`First argument must be a closure at ${closure?.location}`);
  }
  closureType.parameters.forEach((p, i) => {
    const arg = call.argAt(i + 1);
    const argType = getExprType(arg);
    if (!typesAreCompatible(argType, p.type!)) {
      throw new Error(`Expected ${p.type?.name} at ${arg?.location}`);
    }
  });
  call.type = closureType.returnType;
  return call;
};

const checkMemberAccess = (call: Call): Call => {
  const obj = checkTypes(call.argAt(0));
  call.args.set(0, obj);
  return call;
};

const checkFixedArrayInit = (call: Call) => {
  const type = call.type;

  if (!type || !type.isFixedArrayType()) {
    throw new Error(`Expected FixedArray type at ${call.location}`);
  }

  checkFixedArrayType(type);
  call.args.each((arg) => {
    const argType = getExprType(arg);
    if (!argType) {
      throw new Error(`Unable to resolve type for ${arg.location}`);
    }

    if (type.elemType?.isUnionType()) {
      resolveUnionType(type.elemType);
      if (type.elemType.types.length === 0) {
        return;
      }
      const match = type.elemType.types.some((t) =>
        typesAreCompatible(argType, t)
      );
      if (!match) {
        throw new Error(
          `Expected ${type.elemType.name} got ${argType.name} at ${arg.location}`
        );
      }
      return;
    }

    if (!typesAreCompatible(argType, type.elemType)) {
      throw new Error(
        `Expected ${type.elemType?.name} got ${argType?.name} at ${arg.location}`
      );
    }
  });

  return call;
};

const checkWhile = (call: Call) => {
  const cond = call.argAt(0);
  const condType = getExprType(cond);
  if (!cond || !condType || !typesAreCompatible(condType, bool)) {
    throw new Error(
      `While conditions must resolve to a boolean at ${cond?.location}`
    );
  }

  checkTypes(call.argAt(1));
  return call;
};

const checkObjectInit = (call: Call): Call => {
  const literal = call.argAt(0);
  if (!literal?.isObjectLiteral()) {
    throw new Error(`Expected object literal, got ${literal}`);
  }
  checkTypes(literal);

  // Check to ensure literal structure is compatible with nominal structure
  if (!typesAreCompatible(literal.type, call.type, { structuralOnly: true })) {
    const expected = call.type?.isObjectType() ? call.type : undefined;
    const provided = literal.type?.isObjectType() ? literal.type : undefined;

    if (expected && provided) {
      const missing = expected.fields
        .filter((f) => !provided.fields.some((pf) => pf.name === f.name))
        .map((f) => f.name);

      const wrong = expected.fields
        .map((f) => {
          const match = provided.fields.find((pf) => pf.name === f.name);
          if (!match) return undefined;
          return typesAreCompatible(match.type, f.type)
            ? undefined
            : {
                name: f.name,
                expected: f.type?.name.value ?? "unknown",
                actual: match.type?.name.value ?? "unknown",
              };
        })
        .filter(
          (f): f is { name: string; expected: string; actual: string } =>
            Boolean(f)
        );

      const extra = provided.fields
        .filter((pf) => !expected.fields.some((f) => f.name === pf.name))
        .map((f) => f.name);

      const parts: string[] = [];
      if (missing.length) parts.push(`Missing fields: ${missing.join(", ")}`);
      if (wrong.length)
        parts.push(
          `Fields with wrong types: ${wrong
            .map((w) => `${w.name} (expected ${w.expected}, got ${w.actual})`)
            .join(", ")}`
        );
      if (extra.length) parts.push(`Extra fields: ${extra.join(", ")}`);

      const details = parts.length ? ` ${parts.join(". ")}.` : "";
      throw new Error(
        `Object literal type does not match expected type ${expected.name} at ${literal.location}.${details}`
      );
    }

    throw new Error(
      `Object literal type does not match expected type ${call.type?.name} at ${literal.location}`
    );
  }

  return call;
};

const checkExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) {
    throw new Error("Expected export to contain block");
  }

  checkTypes(block);
  return call;
};
