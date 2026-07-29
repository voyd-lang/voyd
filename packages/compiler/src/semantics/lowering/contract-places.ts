import {
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  type Expr,
} from "../../parser/index.js";
import type {
  HirContractPlace,
  HirContractPlaceProjection,
} from "../hir/index.js";
import { toSourceSpan } from "../../parser/surface/utils.js";

export const lowerContractPlace = (
  expression: Expr,
): HirContractPlace | undefined => {
  if (isIdentifierAtom(expression)) {
    return expression.value === "self"
      ? {
          root: "self",
          projections: [],
          span: toSourceSpan(expression),
        }
      : undefined;
  }
  if (!isForm(expression)) {
    return undefined;
  }
  if (expression.calls(".") && expression.length === 3) {
    const target = expression.at(1);
    const member = expression.at(2);
    if (!target || !isIdentifierAtom(member)) {
      return undefined;
    }
    const lowered = lowerContractPlace(target);
    if (!lowered) {
      return undefined;
    }
    const numeric = Number(member.value);
    const projection: HirContractPlaceProjection =
      Number.isInteger(numeric) && String(numeric) === member.value
        ? { kind: "tuple", index: numeric }
        : { kind: "field", name: member.value };
    return {
      ...lowered,
      projections: [...lowered.projections, projection],
      span: toSourceSpan(expression),
    };
  }
  if (
    isIdentifierAtom(expression.first) &&
    expression.first.value === "deref" &&
    expression.length === 2
  ) {
    const target = expression.at(1);
    const lowered = target ? lowerContractPlace(target) : undefined;
    return lowered
      ? {
          ...lowered,
          projections: [
            ...lowered.projections,
            { kind: "dereference" as const },
          ],
          span: toSourceSpan(expression),
        }
      : undefined;
  }
  if (formCallsInternal(expression, "subscript") && expression.length === 3) {
    const target = expression.at(1);
    const index = expression.at(2);
    const lowered = target ? lowerContractPlace(target) : undefined;
    const constant =
      (isIdentifierAtom(index) || isIntAtom(index)) &&
      Number.isInteger(Number(index.value))
        ? Number(index.value)
        : undefined;
    return lowered && typeof constant === "number"
      ? {
          ...lowered,
          projections: [
            ...lowered.projections,
            { kind: "index" as const, constant },
          ],
          span: toSourceSpan(expression),
        }
      : undefined;
  }
  return undefined;
};

export const displayContractPlace = (expression: Expr): string => {
  if (isIdentifierAtom(expression)) {
    return expression.value;
  }
  if (!isForm(expression)) {
    return "<invalid place>";
  }
  if (expression.calls(".") && expression.length === 3) {
    const target = expression.at(1);
    const member = expression.at(2);
    return target && isIdentifierAtom(member)
      ? `${displayContractPlace(target)}.${member.value}`
      : "<invalid place>";
  }
  if (
    isIdentifierAtom(expression.first) &&
    expression.first.value === "deref" &&
    expression.length === 2
  ) {
    const target = expression.at(1);
    return target
      ? `deref(${displayContractPlace(target)})`
      : "<invalid place>";
  }
  if (formCallsInternal(expression, "subscript") && expression.length === 3) {
    const target = expression.at(1);
    const index = expression.at(2);
    return target && (isIdentifierAtom(index) || isIntAtom(index))
      ? `${displayContractPlace(target)}[${index.value}]`
      : "<invalid place>";
  }
  return "<invalid place>";
};
