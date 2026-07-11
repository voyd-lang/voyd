import { CallForm, Form } from "../ast/form.js";
import {
  Expr,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { assertNoMissingBraceEntryComma } from "../surface/brace-entries.js";
import { classifyTopLevelDecl } from "../surface/use-decl.js";

export const constructorObjectLiteral = (form: Form): Form =>
  rewriteExpr(form) as Form;

const rewriteExpr = (expr: Expr, inUseDeclaration = false): Expr =>
  isForm(expr) ? rewriteForm(expr, inUseDeclaration) : expr;

const rewriteForm = (form: Form, inUseDeclaration: boolean): Form => {
  const nextInUseDeclaration =
    inUseDeclaration || classifyTopLevelDecl(form).kind === "use-decl";
  const rewrittenChildren = form
    .toArray()
    .map((child) => rewriteExpr(child, nextInUseDeclaration));
  const rebuilt = rebuildSameKind(form, rewrittenChildren);
  const normalized = normalizeBraceEntryLambda(rebuilt);
  if (normalized.callsInternal("object_literal") && !nextInUseDeclaration) {
    assertNoMissingBraceEntryComma(normalized);
  }
  return liftNamespaceConstructorInit(normalized);
};

// In `{ callback: x: T => body }`, primary parsing initially associates the
// parameter name with the field label. Restore the structural boundary before
// surface validation so the field value is a complete lambda expression.
const normalizeBraceEntryLambda = (form: Form): Form => {
  if (!form.callsInternal("object_literal")) return form;
  let changed = false;
  const entries = form.rest.map((entry) => {
    if (!isForm(entry) || !entry.calls(":")) return entry;
    const nestedLabel = entry.at(1);
    const lambdaTail = entry.at(2);
    if (
      !isForm(nestedLabel) ||
      !nestedLabel.calls(":") ||
      !isForm(lambdaTail) ||
      !lambdaTail.calls("=>")
    ) {
      return entry;
    }
    const field = nestedLabel.at(1);
    const parameter = nestedLabel.at(2);
    const type = lambdaTail.at(1);
    const body = lambdaTail.at(2);
    if (!field || !parameter || !type || !body) return entry;
    const parameterType = new Form({
      location: nestedLabel.location?.clone(),
      elements: [nestedLabel.first!, parameter, type],
    });
    const lambda = new Form({
      location: lambdaTail.location?.clone(),
      elements: [lambdaTail.first!, parameterType, body],
    });
    changed = true;
    return new Form({
      location: entry.location?.clone(),
      elements: [entry.first!, field, lambda],
    });
  });
  return changed ? rebuildSameKind(form, [form.first!, ...entries]) : form;
};

const rebuildSameKind = (original: Form, elements: Expr[]): Form => {
  const rebuilt = new Form({
    location: original.location?.clone(),
    elements,
  });
  return original instanceof CallForm ? rebuilt.toCall() : rebuilt;
};

const isObjectLiteral = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.callsInternal("object_literal");

const isUpperCamelCase = (value: string): boolean => {
  const first = value[0];
  if (!first) return false;
  return first.toUpperCase() === first && first.toLowerCase() !== first;
};

const isUpperCamelConstructorTarget = (expr: Expr | undefined): boolean => {
  if (!expr) return false;

  if (isIdentifierAtom(expr)) {
    return !expr.isQuoted && isUpperCamelCase(expr.value);
  }

  if (!isForm(expr)) {
    return false;
  }

  const head = expr.at(0);
  if (
    !isIdentifierAtom(head) ||
    head.isQuoted ||
    !isUpperCamelCase(head.value)
  ) {
    return false;
  }

  const second = expr.at(1);
  if (expr.length === 1) {
    return true;
  }

  return isForm(second) && formCallsInternal(second, "generics");
};

const isConstructorInitCall = (expr: Expr | undefined): expr is Form => {
  if (!isForm(expr) || expr.length < 2) return false;
  const last = expr.at(-1);
  if (!isObjectLiteral(last)) return false;

  // Only lift when the RHS is a simple constructor-init shape:
  //   MyType { ... }
  //   MyType<i32> { ... }
  // where the only non-type argument is the trailing object literal.
  if (expr.length === 2) {
    return isUpperCamelConstructorTarget(expr.at(0));
  }

  if (
    expr.length === 3 &&
    isForm(expr.at(1)) &&
    formCallsInternal(expr.at(1)!, "generics")
  ) {
    return isUpperCamelConstructorTarget(new Form([expr.at(0)!, expr.at(1)!]));
  }

  return false;
};

// `mod::MyType { ... }` should be treated as `(mod::MyType) { ... }`
// rather than `mod::(MyType { ... })`, so we lift the constructor call out of
// the RHS of `::`.
const liftNamespaceConstructorInit = (form: Form): Form => {
  if (!form.calls("::") || form.length !== 3) {
    return form;
  }

  const left = form.at(1);
  const right = form.at(2);
  if (!left || !isConstructorInitCall(right)) {
    return form;
  }

  const objectLiteral = right.at(-1) as Form;
  const target = right.slice(0, -1).unwrap();
  if (!isUpperCamelConstructorTarget(target)) {
    return form;
  }

  const liftedCallee = new Form({
    location: form.location?.clone(),
    elements: [form.first!, left, target],
  });
  const lifted = new CallForm([liftedCallee, objectLiteral]);
  if (form.location) lifted.setLocation(form.location.clone());
  return lifted;
};
