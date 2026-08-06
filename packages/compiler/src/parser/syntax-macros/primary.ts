import { CallForm, Form } from "../ast/form.js";
import {
  Expr,
  formCallsInternal,
  FormCursor,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import type { SourceLocation } from "../ast/syntax.js";
import { infixOps, isInfixOp, isPrefixOp, prefixOps } from "../grammar.js";

export const primary = (form: Form): Form => parseForm(form);

const parseExpression = (expr: Expr): Expr =>
  isForm(expr) ? parseForm(expr) : expr;

const parseForm = (form: Form): Form => {
  if (form.callsInternal("subscript")) {
    return parseSubscriptForm(form);
  }
  if (
    form instanceof CallForm &&
    !form.toArray().some((entry) => isInfixOp(entry))
  ) {
    return parseDelimitedCallForm(form);
  }

  const hadSingleFormChild = form.length === 1 && isForm(form.at(0));

  if (!form.length) {
    return new Form({ location: form.location?.clone() });
  }

  const items: Expr[] = [];
  const cursor = form.cursor();

  while (!cursor.done) {
    items.push(parsePrecedence(cursor));
  }

  let result: Form;
  if (!hadSingleFormChild && items.length && isForm(items[0])) {
    const head = items[0] as Form;
    const rest = items.slice(1);
    result = formWithLocation(form, [...head.toArray(), ...rest]);
  } else {
    result = formWithLocation(form, items);
  }

  return restructureOperatorTail(result);
};

const parseDelimitedCallForm = (form: CallForm): Form => {
  const items = form.toArray().map(parseExpression);
  if (items.length > 0 && isForm(items[0])) {
    const [head, ...rest] = items;
    return formWithLocation(form, [...head.toArray(), ...rest]);
  }
  return formWithLocation(form, items);
};

const parseSubscriptForm = (form: Form): Form => {
  const head = form.first;
  if (!head) {
    return formWithLocation(form, []);
  }
  const parsedArgs = form.rest.map(parseExpression);
  return formWithLocation(form, [head, ...parsedArgs]);
};

const parsePrecedence = (cursor: FormCursor, minPrecedence = 0): Expr => {
  const first = cursor.peek();
  if (!first) return new Form();

  let expr: Expr;

  if (isPrefixOp(first) && contextualPrefixIsActive(first, cursor)) {
    const op = cursor.consume()!;
    let right = parsePrecedence(cursor, unaryOpInfo(op) ?? -1);
    const genericTail = cursor.peek();
    if (
      isIdentifierAtom(op) &&
      op.value === "borrow" &&
      isForm(genericTail) &&
      genericTail.callsInternal("generics")
    ) {
      const parsedTail = parseExpression(cursor.consume()!);
      right = new Form({
        location: mergeLocation(right, parsedTail),
        elements: [right, parsedTail],
      });
    }
    expr = new Form({
      location: mergeLocation(op, right),
      elements: [op, right],
    });
  } else {
    expr = parseExpression(cursor.consume()!);
  }

  while (!cursor.done) {
    const op = cursor.peek();
    const precedence = infixOpInfo(op);
    if (precedence === undefined || precedence < minPrecedence) break;

    cursor.consume();
    const right = parsePrecedence(cursor, precedence + 1);

    expr = new Form({
      location: mergeLocation(expr, right) ?? mergeLocation(op, right),
      elements: [op!, expr, right],
    });

    if (isForm(expr) && isLambdaWithTupleArgs(expr)) {
      expr = removeTupleFromLambdaParameters(expr);
    }
  }

  return expr;
};

const contextualPrefixIsActive = (op: Expr, cursor: FormCursor): boolean => {
  const next = cursor.peek(1);
  return !(
    isIdentifierAtom(op) &&
    op.value === "borrow" &&
    (next === undefined ||
      isInfixOp(next) ||
      (isForm(next) && next.callsInternal("generics")))
  );
};

const infixOpInfo = (op?: Expr): number | undefined => {
  if (!isIdentifierAtom(op) || op.isQuoted) return undefined;
  return infixOps.get(op.value);
};

const unaryOpInfo = (op?: Expr): number | undefined => {
  if (!isIdentifierAtom(op)) return undefined;
  return prefixOps.get(op.value);
};

const isLambdaWithTupleArgs = (form: Form) =>
  form.calls("=>") && formCallsInternal(form.at(1), "tuple");

const removeTupleFromLambdaParameters = (form: Form): Form => {
  const params = form.at(1);
  if (!isForm(params)) return form;

  const normalizedParams = params.slice(1);
  const elements = form.toArray();
  return new Form({
    location: form.location?.clone(),
    elements: [elements[0]!, normalizedParams, ...elements.slice(2)],
  });
};

const restructureOperatorTail = (form: Form): Form => {
  const op = form.at(0);
  if (
    !isIdentifierAtom(op) ||
    !isInfixOp(op) ||
    op.isQuoted ||
    form.length <= 3
  ) {
    return form;
  }

  const left = form.at(1);
  if (!left) return form;

  const parsedTail = parseForm(form.slice(2));
  return new Form({
    location: form.location?.clone() ?? mergeLocation(op, parsedTail),
    elements: [op, left, parsedTail],
  });
};

const mergeLocation = (
  start: Expr | undefined,
  end: Expr | undefined,
): SourceLocation | undefined => {
  const startLoc = start?.location;
  const endLoc = end?.location ?? startLoc;
  if (!startLoc) {
    return endLoc?.clone();
  }
  const merged = startLoc.clone();
  merged.setEndToEndOf(endLoc);
  return merged;
};

const formWithLocation = (
  original: Form,
  elements: Expr[],
  location?: SourceLocation,
): Form =>
  new Form({
    location: location ?? original.location?.clone(),
    elements,
  });
