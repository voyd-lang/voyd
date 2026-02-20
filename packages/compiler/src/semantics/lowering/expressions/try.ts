import {
  Form,
  type Expr,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import type { LoweringFormParams } from "./types.js";

const collectNamespaceSegments = (
  expr: Expr | undefined
): readonly string[] | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return [expr.value];
  }
  if (!isForm(expr) || !expr.calls("::")) {
    return undefined;
  }
  const left = collectNamespaceSegments(expr.at(1));
  const right = collectNamespaceSegments(expr.at(2));
  if (!left || !right || right.length === 0) {
    return undefined;
  }
  return [...left, ...right];
};

const resolveQualifiedSymbol = ({
  segments,
  scope,
  ctx,
}: {
  segments: readonly string[] | undefined;
  scope: number;
  ctx: LoweringFormParams["ctx"];
}): number | undefined => {
  if (!segments || segments.length === 0) {
    return undefined;
  }
  let current = resolveSymbol(segments[0]!, scope, ctx);
  for (let index = 1; index < segments.length; index += 1) {
    const members = ctx.moduleMembers.get(current);
    if (!members) {
      return undefined;
    }
    const bucket = members.get(segments[index]!);
    if (!bucket || bucket.size === 0) {
      return undefined;
    }
    current = bucket.values().next().value as number;
  }
  return current;
};

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
  const { expr: strippedBody, handlers: embeddedHandlers } =
    stripEmbeddedHandlerClauses(bodyExpr);
  const body = lowerExpr(strippedBody, ctx, scopes);

  const handlerForms = [...collectHandlerForms(form), ...embeddedHandlers];
  const handlers = handlerForms.flatMap((entry) => {
    const clauseScope = ctx.scopeByNode.get(entry.syntaxId);
    if (clauseScope !== undefined) {
      scopes.push(clauseScope);
    }
    const head = entry.at(1);
    const clauseBody = entry.at(2);
    const { operation, effect, parameters, resumable } = lowerHandlerHead(
      head,
      ctx,
      clauseScope ?? scopes.current()
    );
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
        parameters: parameters.map((param) => ({
          ...param,
          mutable: false,
        })),
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
  form.rest.slice(1).forEach((entry) => {
    if (isForm(entry) && entry.calls(":")) {
      handlers.push(entry);
    }
  });
  return handlers;
};

const isHandlerClause = (entry: Expr | undefined): entry is Form =>
  isForm(entry) &&
  entry.calls(":") &&
  isForm(entry.at(2)) &&
  (entry.at(2) as Form).calls("block");

const stripEmbeddedHandlerClauses = (
  expr: Expr
): { expr: Expr; handlers: Form[] } => {
  if (!isForm(expr)) {
    return { expr, handlers: [] };
  }
  let changed = false;
  const handlers: Form[] = [];
  const rewritten: Expr[] = [];

  expr.toArray().forEach((child) => {
    if (isHandlerClause(child)) {
      handlers.push(child);
      changed = true;
      return;
    }
    const { expr: nextExpr, handlers: nested } = stripEmbeddedHandlerClauses(child);
    if (nested.length > 0) {
      handlers.push(...nested);
      if (nextExpr !== child) {
        changed = true;
      }
    }
    rewritten.push(nextExpr);
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
        : resolveQualifiedSymbol({
            segments: collectNamespaceSegments(effectExpr),
            scope,
            ctx,
          });
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

  const parseParam = (
    expr: Expr
  ): { name: string; span: ReturnType<typeof toSourceSpan>; typeExpr?: Expr } | undefined => {
    if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
      return { name: expr.value, span: toSourceSpan(expr) };
    }
    if (isForm(expr) && expr.calls(":")) {
      const nameExpr = expr.at(1);
      const typeExpr = expr.at(2);
      if (
        (isIdentifierAtom(nameExpr) || isInternalIdentifierAtom(nameExpr)) &&
        typeExpr
      ) {
        return {
          name: nameExpr.value,
          span: toSourceSpan(nameExpr),
          typeExpr,
        };
      }
    }
    return undefined;
  };

  const namespaced = collectNamespaceSegments(head);
  if (namespaced && namespaced.length > 1) {
    const opName = namespaced.at(-1)!;
    const effectPath = namespaced.slice(0, -1);
    const effectSymbolFromPath =
      effectSymbol ??
      resolveQualifiedSymbol({
        segments: effectPath,
        scope,
        ctx,
      });
    const resolvedOperation =
      effectSymbolFromPath !== undefined
        ? ctx.moduleMembers
            .get(effectSymbolFromPath)
            ?.get(opName)
            ?.values()
            .next().value
        : undefined;
    const operation =
      resolvedOperation ??
      resolveEffectOperationSymbol({
        opName,
        scope,
        ctx,
      });
    const callArgs = isForm(head) ? head.rest : [];
    const parsedParams = callArgs.map((entry) =>
      entry ? parseParam(entry) : undefined
    );
    const params = parsedParams
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((param) => ({
        symbol: resolveSymbol(param.name, scope, ctx),
        span: param.span,
        type: param.typeExpr ? lowerTypeExpr(param.typeExpr, ctx, scope) : undefined,
      }));
    const opDecl = ctx.decls.getEffectOperation(operation);
    const resumable = opDecl?.operation.resumable === "tail" ? "fn" : "ctl";
    return { operation, parameters: params, resumable };
  }

  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    const operation =
      effectSymbol !== undefined
        ? ctx.moduleMembers.get(effectSymbol)?.get(head.value)?.values().next()
            .value ??
          resolveEffectOperationSymbol({
            opName: head.value,
            scope,
            ctx,
          })
        : resolveEffectOperationSymbol({
            opName: head.value,
            scope,
            ctx,
          });
    const opDecl = ctx.decls.getEffectOperation(operation);
    const resumable = opDecl?.operation.resumable === "tail" ? "fn" : "ctl";
    return { operation, parameters: [], resumable };
  }

  if (!isForm(head)) {
    throw new Error("invalid handler head");
  }

  const opName = head.at(0);
  if (!isIdentifierAtom(opName) && !isInternalIdentifierAtom(opName)) {
    throw new Error("handler operation must be an identifier");
  }
  const candidates =
    effectSymbol !== undefined
      ? ctx.moduleMembers.get(effectSymbol)?.get(opName.value)
      : undefined;

  const parsedParams = head.rest.map((entry) => (entry ? parseParam(entry) : undefined));
  const params = parsedParams
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((param) => ({
      symbol: resolveSymbol(param.name, scope, ctx),
      span: param.span,
      type: param.typeExpr ? lowerTypeExpr(param.typeExpr, ctx, scope) : undefined,
    }));

  const resolvedOperation =
    candidates && candidates.size > 0
      ? (candidates.values().next().value as number)
      : undefined;

  const operation =
    resolvedOperation ??
    resolveEffectOperationSymbol({
      opName: opName.value,
      scope,
      ctx,
    });
  const opDecl = ctx.decls.getEffectOperation(operation);
  const resumable = opDecl?.operation.resumable === "tail" ? "fn" : "ctl";
  return { operation, parameters: params, resumable };
};

const resolveEffectOperationSymbol = ({
  opName,
  scope,
  ctx,
}: {
  opName: string;
  scope: number;
  ctx: LoweringFormParams["ctx"];
}): number =>
  ctx.symbolTable.resolveByKinds(opName, scope, ["effect-op"]) ??
  resolveSymbol(opName, scope, ctx);
