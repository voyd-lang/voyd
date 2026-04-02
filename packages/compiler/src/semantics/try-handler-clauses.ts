import {
  Form,
  type Expr,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";
import type { ScopeId } from "./ids.js";

type ResolveBareHandlerHead = (options: {
  name: string;
  scope: ScopeId;
}) => boolean;

type GetNestedScope = (options: {
  expr: Form;
  parentScope: ScopeId;
}) => ScopeId;

type TryHandlerClauseOptions = {
  expr: Expr | undefined;
  scope: ScopeId;
  resolveBareHandlerHead: ResolveBareHandlerHead;
};

type TryHandlerTraversalOptions = TryHandlerClauseOptions & {
  getNestedScope?: GetNestedScope;
};

type StrippedTryHandlerClauses = {
  expr: Expr;
  handlers: Form[];
};

const getScopeForNestedExpr = ({
  expr,
  parentScope,
  getNestedScope,
}: {
  expr: Expr | undefined;
  parentScope: ScopeId;
  getNestedScope?: GetNestedScope;
}): ScopeId => {
  if (!expr || !isForm(expr)) {
    return parentScope;
  }

  return getNestedScope?.({ expr, parentScope }) ?? parentScope;
};

const isEffectHandlerHead = (expr: Expr | undefined): boolean => {
  if (!isForm(expr)) {
    return false;
  }

  if (expr.calls("::")) {
    return isForm(expr.at(2));
  }

  return true;
};

export const isTryHandlerClause = (
  options: TryHandlerClauseOptions,
): boolean => {
  const { expr, scope, resolveBareHandlerHead } = options;
  if (!isForm(expr) || !expr.calls(":") || !isEffectHandlerHead(expr.at(1))) {
    return false;
  }

  const head = expr.at(1);
  if (
    isForm(head) &&
    !head.calls("::") &&
    !isBareEffectHandlerHead({
      expr: head,
      scope,
      resolveBareHandlerHead,
    })
  ) {
    return false;
  }

  const body = expr.at(2);
  return isForm(body) && body.calls("block");
};

export const collectTryHandlerClauses = ({
  expr,
  scope,
  resolveBareHandlerHead,
  getNestedScope,
}: TryHandlerTraversalOptions): Form[] => {
  if (!isForm(expr) || expr.calls("try")) {
    return [];
  }

  const handlers: Form[] = [];
  expr.toArray().forEach((child) => {
    if (
      isTryHandlerClause({ expr: child, scope, resolveBareHandlerHead }) &&
      isForm(child)
    ) {
      handlers.push(child);
      return;
    }

    if (isForm(child) && child.calls(":")) {
      const label = child.at(1);
      const value = child.at(2);
      if (label) {
        handlers.push(
          ...collectTryHandlerClauses({
            expr: label,
            scope: getScopeForNestedExpr({
              expr: label,
              parentScope: scope,
              getNestedScope,
            }),
            resolveBareHandlerHead,
            getNestedScope,
          }),
        );
      }
      if (value) {
        handlers.push(
          ...collectTryHandlerClauses({
            expr: value,
            scope: getScopeForNestedExpr({
              expr: value,
              parentScope: scope,
              getNestedScope,
            }),
            resolveBareHandlerHead,
            getNestedScope,
          }),
        );
      }
      return;
    }

    handlers.push(
      ...collectTryHandlerClauses({
        expr: child,
        scope: getScopeForNestedExpr({
          expr: child,
          parentScope: scope,
          getNestedScope,
        }),
        resolveBareHandlerHead,
        getNestedScope,
      }),
    );
  });

  return handlers;
};

export const stripTryHandlerClauses = ({
  expr,
  scope,
  resolveBareHandlerHead,
  getNestedScope,
}: TryHandlerTraversalOptions): StrippedTryHandlerClauses => {
  if (!expr || !isForm(expr) || expr.calls("try")) {
    return expr
      ? { expr, handlers: [] }
      : { expr: new Form().unwrap(), handlers: [] };
  }

  let changed = false;
  const handlers: Form[] = [];
  const rewritten: Expr[] = [];

  expr.toArray().forEach((child) => {
    if (
      isTryHandlerClause({ expr: child, scope, resolveBareHandlerHead }) &&
      isForm(child)
    ) {
      handlers.push(child);
      changed = true;
      return;
    }

    if (isForm(child) && child.calls(":")) {
      const nextElements = child.toArray();
      const label = child.at(1);
      const value = child.at(2);
      const labelResult = label
        ? stripTryHandlerClauses({
            expr: label,
            scope: getScopeForNestedExpr({
              expr: label,
              parentScope: scope,
              getNestedScope,
            }),
            resolveBareHandlerHead,
            getNestedScope,
          })
        : undefined;
      const valueResult = value
        ? stripTryHandlerClauses({
            expr: value,
            scope: getScopeForNestedExpr({
              expr: value,
              parentScope: scope,
              getNestedScope,
            }),
            resolveBareHandlerHead,
            getNestedScope,
          })
        : undefined;
      const nextLabel = labelResult?.expr ?? label;
      const labelHandlers = labelResult?.handlers ?? [];
      const nextValue = valueResult?.expr ?? value;
      const valueHandlers = valueResult?.handlers ?? [];
      if (labelHandlers.length > 0 || valueHandlers.length > 0) {
        handlers.push(...labelHandlers, ...valueHandlers);
      }
      if (nextLabel && nextLabel !== label) {
        nextElements[1] = nextLabel;
        changed = true;
      }
      if (nextValue && nextValue !== value) {
        nextElements[2] = nextValue;
        changed = true;
      }
      rewritten.push(
        nextLabel !== label || nextValue !== value
          ? new Form({
              location: child.location?.clone(),
              elements: nextElements,
            }).unwrap()
          : child,
      );
      return;
    }

    const nextResult = stripTryHandlerClauses({
      expr: child,
      scope: getScopeForNestedExpr({
        expr: child,
        parentScope: scope,
        getNestedScope,
      }),
      resolveBareHandlerHead,
      getNestedScope,
    });
    if (nextResult.handlers.length > 0) {
      handlers.push(...nextResult.handlers);
      if (nextResult.expr !== child) {
        changed = true;
      }
    }
    rewritten.push(nextResult.expr);
  });

  if (!changed) {
    return { expr, handlers };
  }

  const rebuilt = new Form({
    location: expr.location?.clone(),
    elements: rewritten,
  });
  return { expr: rebuilt.unwrap(), handlers };
};

const isBareEffectHandlerHead = ({
  expr,
  scope,
  resolveBareHandlerHead,
}: {
  expr: Expr;
  scope: ScopeId;
  resolveBareHandlerHead: ResolveBareHandlerHead;
}): boolean => {
  if (!isForm(expr)) {
    return false;
  }

  const callee = expr.at(0);
  if (!isIdentifierAtom(callee) && !isInternalIdentifierAtom(callee)) {
    return false;
  }

  return resolveBareHandlerHead({ name: callee.value, scope });
};
