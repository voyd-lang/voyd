import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import {
  parseSurfaceHandlerClause,
  parseSurfaceTryExpression,
  type SurfaceHandlerHead,
} from "../../../parser/surface/index.js";
import {
  isTryHandlerClause,
  stripTryHandlerClauses,
} from "../../try-handler-clauses.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import type { LoweringFormParams } from "./types.js";
import { resolveUnqualifiedEffectOperation } from "../../effect-operation-resolution.js";

const collectNamespaceSegments = (
  expr: Expr | undefined,
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
  const {
    openUnhandled: hasOpenUnhandled,
    bodyIndex,
    body: bodyExpr,
  } = parseSurfaceTryExpression(form);
  const { expr: strippedBody, handlers: embeddedHandlers } =
    stripTryHandlerClauses({
      expr: bodyExpr,
      scope: scopes.current(),
      resolveBareHandlerHead: ({ name, scope }) =>
        typeof resolveUnqualifiedEffectOperation({
          name,
          scope,
          symbolTable: ctx.symbolTable,
        }) === "number",
      getNestedScope: ({ expr, parentScope }) =>
        ctx.scopeByNode.get(expr.syntaxId) ?? parentScope,
    });
  const body = lowerExpr(strippedBody, ctx, scopes);

  const handlerForms = [
    ...collectHandlerForms({ form, bodyIndex, ctx, scope: scopes.current() }),
    ...embeddedHandlers,
  ];
  const handlers = handlerForms.flatMap((entry) => {
    const clauseScope = ctx.scopeByNode.get(entry.syntaxId);
    if (clauseScope !== undefined) {
      scopes.push(clauseScope);
    }
    const { head, body: clauseBody } = parseSurfaceHandlerClause(entry);
    const { operation, effect, parameters, resumable } = lowerHandlerHead(
      head,
      ctx,
      clauseScope ?? scopes.current(),
    );
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
    ...(hasOpenUnhandled ? { openUnhandled: true } : {}),
  });

  return exprId;
};

const collectHandlerForms = ({
  form,
  bodyIndex,
  ctx,
  scope,
}: {
  form: Form;
  bodyIndex: number;
  ctx: LoweringFormParams["ctx"];
  scope: number;
}): Form[] => {
  const body = form.at(bodyIndex);
  const handlers: Form[] = [];
  if (isForm(body) && body.calls("block")) {
    body.rest.forEach((entry) => {
      if (
        isTryHandlerClause({
          expr: entry,
          scope,
          resolveBareHandlerHead: ({ name, scope: headScope }) =>
            typeof ctx.symbolTable.resolveByKinds(name, headScope, [
              "effect-op",
            ]) === "number",
        }) &&
        isForm(entry)
      ) {
        handlers.push(entry);
      }
    });
  }
  form.rest.slice(bodyIndex).forEach((entry) => {
    if (
      isTryHandlerClause({
        expr: entry,
        scope,
        resolveBareHandlerHead: ({ name, scope: headScope }) =>
          typeof ctx.symbolTable.resolveByKinds(name, headScope, [
            "effect-op",
          ]) === "number",
      }) &&
      isForm(entry)
    ) {
      handlers.push(entry);
    }
  });
  return handlers;
};

const lowerHandlerHead = (
  head: SurfaceHandlerHead,
  ctx: LoweringFormParams["ctx"],
  scope: number,
): {
  operation: number;
  effect?: number;
  parameters: { symbol: number; span: ReturnType<typeof toSourceSpan> }[];
  resumable: "ctl" | "fn";
} => {
  const effectSymbol = head.effectExpr
    ? isIdentifierAtom(head.effectExpr)
      ? resolveSymbol(head.effectExpr.value, scope, ctx)
      : resolveQualifiedSymbol({
          segments: collectNamespaceSegments(head.effectExpr),
          scope,
          ctx,
        })
    : undefined;
  const opName = head.operation.value;
  const candidates =
    effectSymbol !== undefined
      ? ctx.moduleMembers.get(effectSymbol)?.get(opName)
      : undefined;
  const parameters = head.parameters.map((param) => ({
    symbol: resolveSymbol(param.name, scope, ctx),
    span: toSourceSpan(param.syntax),
    type: param.typeExpr
      ? lowerTypeExpr(param.typeExpr, ctx, scope)
      : undefined,
  }));

  const resolvedOperation =
    candidates && candidates.size > 0
      ? (candidates.values().next().value as number)
      : undefined;

  const operation =
    resolvedOperation ??
    resolveEffectOperationSymbol({
      opName,
      scope,
      ctx,
    });
  const opDecl = ctx.decls.getEffectOperation(operation);
  const resumable = opDecl?.operation.resumable === "tail" ? "fn" : "ctl";
  return {
    operation,
    ...(effectSymbol !== undefined ? { effect: effectSymbol } : {}),
    parameters,
    resumable,
  };
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
  resolveUnqualifiedEffectOperation({
    name: opName,
    scope,
    symbolTable: ctx.symbolTable,
  }) ?? resolveSymbol(opName, scope, ctx);
