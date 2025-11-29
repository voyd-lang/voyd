import { Form } from "../ast/form.js";
import {
  Expr,
  formCallsInternal,
  FormCursor,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { infixOps, isInfixOp, isPrefixOp, prefixOps } from "../grammar.js";

export const primary = (form: Form): Form => parseForm(form);

const parseExpression = (expr: Expr): Expr =>
  isForm(expr) ? parseForm(expr) : expr;

const parseForm = (form: Form): Form => {
  const hadSingleFormChild = form.length === 1 && isForm(form.at(0));

  if (!form.length) {
    return new Form({ location: form.location?.clone() });
  }

  const items: Expr[] = [];
  const cursor = form.cursor();

  while (!cursor.done) {
    items.push(parsePrecedence(cursor, 0));
  }

  let result: Form;
  if (!hadSingleFormChild && items.length && isForm(items[0])) {
    const head = items[0] as Form;
    const rest = items.slice(1);
    result = new Form([...head.toArray(), ...rest]);
  } else {
    result = new Form(items);
  }

  return restructureOperatorTail(result);
};

const parsePrecedence = (cursor: FormCursor, minPrecedence = 0): Expr => {
  const first = cursor.peek();
  if (!first) return new Form();

  let expr: Expr;

  if (isPrefixOp(first)) {
    const op = cursor.consume()!;
    const right = parsePrecedence(cursor, unaryOpInfo(op) ?? -1);
    expr = new Form([op, right]);
  } else {
    expr = parseExpression(cursor.consume()!);
  }

  while (!cursor.done) {
    const op = cursor.peek();
    const precedence = infixOpInfo(op);
    if (precedence === undefined || precedence < minPrecedence) break;

    cursor.consume();
    const right = parsePrecedence(cursor, precedence + 1);

    expr = new Form([op!, expr, right]);

    if (isForm(expr) && isLambdaWithTupleArgs(expr)) {
      expr = removeTupleFromLambdaParameters(expr);
    }
  }

  return expr;
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
  return new Form([elements[0]!, normalizedParams, ...elements.slice(2)]);
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
  return new Form([op, left, parsedTail]);
};
