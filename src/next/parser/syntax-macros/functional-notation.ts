import { CallForm, Form } from "../ast/form.js";
import { Expr, isForm, isWhitespaceAtom } from "../ast/index.js";
import { isOp } from "../grammar.js";

export const functionalNotation = (form: Form): Form => {
  const cursor = form.cursor();
  const result: Expr[] = [];

  if (isParams(form)) {
    result.push(cursor.consume()!);
  }

  while (!cursor.done) {
    const expr = cursor.consume();
    if (!expr) break;

    if (isForm(expr)) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (isWhitespaceAtom(expr)) {
      result.push(expr);
      continue;
    }

    const nextExpr = cursor.peek();
    if (isOp(expr) || !isForm(nextExpr)) {
      result.push(expr);
      continue;
    }

    if (nextExpr.callsInternal("generics")) {
      cursor.consume();
      const params = cursor.peek();
      if (isParams(params)) cursor.consume();
      result.push(
        new CallForm([
          expr,
          nextExpr,
          ...(isParams(params) ? functionalNotation(params).rest : []),
        ])
      );
      continue;
    }

    if (isParams(nextExpr)) {
      cursor.consume();
      result.push(new CallForm([expr, ...functionalNotation(nextExpr).rest]));
      continue;
    }

    result.push(expr);
  }

  return new Form({ location: form.location?.clone(), elements: result });
};

const isParams = (expr: unknown): expr is Form =>
  isForm(expr) && (expr.callsInternal("paren") || expr.callsInternal("tuple"));
