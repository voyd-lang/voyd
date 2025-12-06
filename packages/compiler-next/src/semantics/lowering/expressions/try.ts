import type { Form, Expr } from "../../../parser/index.js";
import { isForm, isIdentifierAtom, isInternalIdentifierAtom } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveSymbol } from "../resolution.js";
import type { LoweringFormParams } from "./types.js";

export const lowerTry = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): number => {
  const bodyExpr = form.at(1);
  if (!bodyExpr) {
    throw new Error("try expression missing body");
  }
  const body = lowerExpr(bodyExpr, ctx, scopes);

  const handlerForms = collectHandlerForms(form);
  const handlers = handlerForms.flatMap((entry) => {
    const clauseScope = ctx.scopeByNode.get(entry.syntaxId);
    if (clauseScope !== undefined) {
      scopes.push(clauseScope);
    }
    const head = entry.at(1);
    const clauseBody = entry.at(2);
    const { operation, effect, parameters, resumable } = lowerHandlerHead(head, ctx, clauseScope ?? scopes.current());
    if (!clauseBody) {
      throw new Error("effect handler clause missing body");
    }
    const bodyId = lowerExpr(clauseBody, ctx, scopes);
    if (clauseScope !== undefined) {
      scopes.pop();
    }
    return [
      {
        operation,
        effect,
        resumable,
        parameters,
        body: bodyId,
      },
    ];
  });

  const exprId = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "effect-handler",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    body,
    handlers,
  });

  return exprId;
};

const collectHandlerForms = (form: Form): Form[] => {
  const body = form.at(1);
  const handlers: Form[] = [];
  if (isForm(body) && body.calls("block")) {
    body.rest.forEach((entry) => {
      if (isForm(entry) && entry.calls(":")) {
        handlers.push(entry);
      }
    });
  }
  form.rest.slice(2).forEach((entry) => {
    if (isForm(entry) && entry.calls(":")) {
      handlers.push(entry);
    }
  });
  return handlers;
};

const lowerHandlerHead = (
  head: Expr | undefined,
  ctx: LoweringFormParams["ctx"],
  scope: number
): {
  operation: number;
  effect?: number;
  parameters: { symbol: number; span: ReturnType<typeof toSourceSpan> }[];
  resumable: "ctl" | "fn";
} => {
  if (!head) {
    throw new Error("effect handler missing head");
  }

  if (isForm(head) && head.calls("::")) {
    const effectExpr = head.at(1);
    const opExpr = head.at(2);
    const effectSymbol =
      effectExpr && isIdentifierAtom(effectExpr)
        ? resolveSymbol(effectExpr.value, scope, ctx)
        : undefined;
    const { operation, parameters, resumable } = lowerHandlerCall(
      opExpr,
      ctx,
      scope,
      effectSymbol
    );
    return { operation, effect: effectSymbol, parameters, resumable };
  }

  const { operation, parameters, resumable } = lowerHandlerCall(
    head,
    ctx,
    scope
  );
  return { operation, parameters, resumable };
};

const lowerHandlerCall = (
  head: Expr | undefined,
  ctx: LoweringFormParams["ctx"],
  scope: number,
  effectSymbol?: number
): {
  operation: number;
  parameters: { symbol: number; span: ReturnType<typeof toSourceSpan> }[];
  resumable: "ctl" | "fn";
} => {
  if (!head) {
    throw new Error("handler head missing operation");
  }

  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    const operation =
      effectSymbol !== undefined
        ? ctx.moduleMembers.get(effectSymbol)?.get(head.value)?.values().next()
            .value ?? resolveSymbol(head.value, scope, ctx)
        : resolveSymbol(head.value, scope, ctx);
    return { operation, parameters: [], resumable: "ctl" };
  }

  if (!isForm(head)) {
    throw new Error("invalid handler head");
  }

  const opName = head.at(0);
  if (!isIdentifierAtom(opName) && !isInternalIdentifierAtom(opName)) {
    throw new Error("handler operation must be an identifier");
  }
  const operation =
    effectSymbol !== undefined
      ? ctx.moduleMembers.get(effectSymbol)?.get(opName.value)?.values().next()
          .value ?? resolveSymbol(opName.value, scope, ctx)
      : resolveSymbol(opName.value, scope, ctx);
  const params = head.rest
    .filter((param) => isIdentifierAtom(param) || isInternalIdentifierAtom(param))
    .map((param) => {
      const symbol = resolveSymbol((param as any).value, scope, ctx);
      return {
        symbol,
        span: toSourceSpan(param),
      };
    });
  const firstName = head.rest[0];
  const resumable =
    isIdentifierAtom(firstName) && firstName.value === "tail"
      ? "fn"
      : "ctl";
  return { operation, parameters: params, resumable };
};
