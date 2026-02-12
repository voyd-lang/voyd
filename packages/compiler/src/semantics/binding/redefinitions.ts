import type { Syntax } from "../../parser/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";
import { toSourceSpan } from "../utils.js";
import type { BindingContext } from "./types.js";
import { findLocalBindingNameCollision } from "./name-collisions.js";

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
  const existing = findLocalBindingNameCollision({ name, scope, ctx });
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
            span: existing.span,
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
