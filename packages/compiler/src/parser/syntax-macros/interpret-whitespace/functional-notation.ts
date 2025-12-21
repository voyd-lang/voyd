import {
  CallForm,
  Expr,
  Form,
  isCallForm,
  isForm,
  isWhitespaceAtom,
} from "../../ast/index.js";
import { isOp } from "../../grammar.js";

/**
 * Converts functional call notation into the internal call form.
 *
 * Example: `foo(bar)` becomes `(foo bar)`.
 */
export const applyFunctionalNotation = (form: Form): Form => {
  const cursor = form.cursor();
  const result: Expr[] = [];

  if (isParams(form)) {
    result.push(cursor.consume()!);
  }

  while (!cursor.done) {
    const expr = cursor.consume();
    if (!expr) break;

    if (isForm(expr)) {
      result.push(applyFunctionalNotation(expr));
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
      const paramsForm = isParams(params) ? params : undefined;
      if (paramsForm) cursor.consume();
      const normalizedParams = paramsForm
        ? applyFunctionalNotation(paramsForm)
        : undefined;
      const call = new CallForm([
        expr,
        nextExpr,
        ...(normalizedParams ? normalizedParams.rest : []),
      ]);
      result.push(call);
      continue;
    }

    if (isParams(nextExpr)) {
      cursor.consume();
      const normalizedParams = applyFunctionalNotation(nextExpr);
      const call = new CallForm([expr, ...normalizedParams.rest]);
      result.push(call);
      continue;
    }

    result.push(expr);
  }

  const newForm = new Form({
    location: form.location?.clone(),
    elements: result,
  });

  return isCallForm(form) ? newForm.toCall() : newForm;
};

const isParams = (expr: unknown): expr is Form =>
  isForm(expr) && (expr.callsInternal("paren") || expr.callsInternal("tuple"));
