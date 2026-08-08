import {
  type Form,
  identifierBindingKey,
  isForm,
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
import {
  canonicalEffectIdentitySymbol,
  canonicalEffectOperationIdentitySymbol,
  resolveQualifiedEffectOperation,
  resolveUnqualifiedEffectOperation,
} from "../../effect-operation-resolution.js";
import { resolveModulePathSymbol } from "./namespace-resolution.js";

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
      resolveBareHandlerHead: ({ name, scope, syntax }) =>
        typeof resolveUnqualifiedEffectOperation({
          name,
          scope,
          symbolTable: ctx.symbolTable,
          bindingIdentity: identifierBindingKey(syntax),
          directSymbol: ctx.directSymbolBySyntax.get(syntax.syntaxId),
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
          resolveBareHandlerHead: ({ name, scope: headScope, syntax }) =>
            typeof resolveUnqualifiedEffectOperation({
              name,
              scope: headScope,
              symbolTable: ctx.symbolTable,
              bindingIdentity: identifierBindingKey(syntax),
              directSymbol: ctx.directSymbolBySyntax.get(syntax.syntaxId),
            }) === "number",
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
        resolveBareHandlerHead: ({ name, scope: headScope, syntax }) =>
          typeof resolveUnqualifiedEffectOperation({
            name,
            scope: headScope,
            symbolTable: ctx.symbolTable,
            bindingIdentity: identifierBindingKey(syntax),
            directSymbol: ctx.directSymbolBySyntax.get(syntax.syntaxId),
          }) === "number",
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
    ? resolveModulePathSymbol(head.effectExpr, scope, ctx)
    : undefined;
  if (
    head.effectExpr &&
    (typeof effectSymbol !== "number" ||
      ctx.symbolTable.getSymbol(effectSymbol).kind !== "effect")
  ) {
    throw new Error(
      `${head.operation.value} handler qualifier does not resolve to an effect`,
    );
  }
  const opName = head.operation.value;
  const parameters = head.parameters.map((param) => ({
    symbol: resolveSymbol(param.name, scope, ctx, {
      bindingIdentity: identifierBindingKey(param.syntax),
      directSymbol: ctx.directSymbolBySyntax.get(param.syntax.syntaxId),
    }),
    span: toSourceSpan(param.syntax),
    type: param.typeExpr
      ? lowerTypeExpr(param.typeExpr, ctx, scope)
      : undefined,
  }));

  const operation =
    typeof effectSymbol === "number"
      ? resolveQualifiedEffectOperation({
          effectSymbol,
          name: opName,
          symbolTable: ctx.symbolTable,
          moduleMembers: ctx.moduleMembers,
          bindingIdentity: identifierBindingKey(head.operation),
          directSymbol: ctx.directSymbolBySyntax.get(head.operation.syntaxId),
        })
      : resolveUnqualifiedEffectOperation({
          name: opName,
          scope,
          symbolTable: ctx.symbolTable,
          bindingIdentity: identifierBindingKey(head.operation),
          directSymbol: ctx.directSymbolBySyntax.get(head.operation.syntaxId),
        });
  if (typeof operation !== "number") {
    const effectName =
      typeof effectSymbol === "number"
        ? ctx.symbolTable.getSymbol(effectSymbol).name
        : undefined;
    throw new Error(
      effectName
        ? `effect ${effectName} does not declare operation ${opName}`
        : `${opName} does not resolve to an imported effect operation`,
    );
  }
  const opDecl = effectOperationDeclFor({ operation, ctx });
  const resumable = opDecl?.operation.resumable === "tail" ? "fn" : "ctl";
  return {
    operation: canonicalEffectOperationIdentitySymbol({
      operationSymbol: operation,
      symbolTable: ctx.symbolTable,
    }),
    ...(effectSymbol !== undefined
      ? {
          effect: canonicalEffectIdentitySymbol({
            effectSymbol,
            symbolTable: ctx.symbolTable,
          }),
        }
      : {}),
    parameters,
    resumable,
  };
};

const effectOperationDeclFor = ({
  operation,
  ctx,
}: {
  operation: number;
  ctx: LoweringFormParams["ctx"];
}) => {
  const local = ctx.decls.getEffectOperation(operation);
  if (local) {
    return local;
  }
  const metadata = ctx.symbolTable.getSymbol(operation).metadata as
    | { import?: { moduleId?: unknown; symbol?: unknown } }
    | undefined;
  const moduleId = metadata?.import?.moduleId;
  const importedSymbol = metadata?.import?.symbol;
  return typeof moduleId === "string" && typeof importedSymbol === "number"
    ? ctx.dependencies.get(moduleId)?.decls.getEffectOperation(importedSymbol)
    : undefined;
};
