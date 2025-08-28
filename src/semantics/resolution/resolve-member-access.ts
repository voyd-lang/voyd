import { Call } from "../../syntax-objects/call.js";
import { Identifier, List } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";

/**
 * Attempts to rewrite a single-arg call `foo(a)` into a member access
 * call when `a`'s type has a field named `foo`.
 * Returns a new `member-access` Call or undefined when not applicable.
 */
export const tryResolveMemberAccessSugar = (call: Call): Call | undefined => {
  if (call.args.length > 1) return;
  const recv = call.argAt(0);
  if (!recv) return;
  const recvType = getExprType(recv);

  if (recvType && recvType.isObjectType() && recvType.hasField(call.fnName)) {
    return new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({ value: [recv, call.fnName] }),
      type: recvType.getField(call.fnName)?.type,
    });
  }

  if (
    recvType &&
    recvType.isIntersectionType() &&
    (recvType.nominalType?.hasField(call.fnName) ||
      recvType.structuralType?.hasField(call.fnName))
  ) {
    const field =
      recvType.nominalType?.getField(call.fnName) ??
      recvType.structuralType?.getField(call.fnName);

    return new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({ value: [recv, call.fnName] }),
      type: field?.type,
    });
  }

  return undefined;
};

