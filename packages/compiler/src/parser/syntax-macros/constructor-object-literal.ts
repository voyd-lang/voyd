import { CallForm, Form } from "../ast/form.js";
import { Expr, formCallsInternal, isForm, isIdentifierAtom } from "../ast/index.js";

export const constructorObjectLiteral = (form: Form): Form =>
  rewriteExpr(form) as Form;

const rewriteExpr = (expr: Expr): Expr => (isForm(expr) ? rewriteForm(expr) : expr);

const rewriteForm = (form: Form): Form => {
  const rewrittenChildren = form.toArray().map(rewriteExpr);
  const rebuilt = rebuildSameKind(form, rewrittenChildren);
  return liftNamespaceConstructorInit(rebuilt);
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
  if (!isIdentifierAtom(head) || head.isQuoted || !isUpperCamelCase(head.value)) {
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

  if (expr.length === 3 && isForm(expr.at(1)) && formCallsInternal(expr.at(1)!, "generics")) {
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

