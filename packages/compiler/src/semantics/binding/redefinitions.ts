import type { Syntax } from "../../parser/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import type { SymbolRecord } from "../binder/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";
import { toSourceSpan } from "../utils.js";
import type { BindingContext } from "./types.js";

const isLocalBinding = (record: SymbolRecord): boolean => {
  const metadata = record.metadata as { localBinding?: unknown } | undefined;
  return metadata?.localBinding === true;
};

const findBindingInScope = ({
  name,
  scope,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  ctx: BindingContext;
}): SymbolRecord | undefined => {
  for (const symbolId of ctx.symbolTable.symbolsInScope(scope)) {
    const record = ctx.symbolTable.getSymbol(symbolId);
    if (record.name !== name) {
      continue;
    }
    if (!isLocalBinding(record)) {
      continue;
    }
    return record;
  }

  return undefined;
};

const spanForNode = (nodeId: NodeId, ctx: BindingContext) =>
  toSourceSpan(ctx.syntaxByNode.get(nodeId));

export const declareValueOrParameter = ({
  name,
  kind,
  declaredAt,
  metadata,
  scope,
  syntax,
  ctx,
}: {
  name: string;
  kind: "value" | "parameter";
  declaredAt: NodeId;
  metadata?: Record<string, unknown>;
  scope: ScopeId;
  syntax?: Syntax;
  ctx: BindingContext;
}): SymbolId => {
  const existing = findBindingInScope({ name, scope, ctx });
  if (existing) {
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0006",
        params: { kind: "duplicate-binding", name },
        span: toSourceSpan(syntax),
        related: [
          diagnosticFromCode({
            code: "BD0006",
            params: { kind: "previous-binding" },
            severity: "note",
            span: spanForNode(existing.declaredAt, ctx),
          }),
        ],
      })
    );
  }

  return ctx.symbolTable.declare(
    {
      name,
      kind,
      declaredAt,
      metadata: { ...metadata, localBinding: true },
    },
    scope
  );
};
