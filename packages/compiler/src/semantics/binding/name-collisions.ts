import type { Syntax } from "../../parser/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import type { SymbolKind, SymbolRecord } from "../binder/index.js";
import type { ScopeId, SourceSpan, SymbolId } from "../ids.js";
import { toSourceSpan } from "../../parser/surface/utils.js";
import type { BindingContext } from "./types.js";
import { bindingIdentityForSyntax } from "./hygiene.js";

type ScopeSymbol = {
  symbolId: SymbolId;
  record: SymbolRecord;
  span: SourceSpan;
};

export type BindingNameCollision = {
  symbolId: SymbolId;
  kind: SymbolKind;
  span: SourceSpan;
};

const symbolsNamedInScope = ({
  name,
  scope,
  ctx,
  skipSymbol,
  bindingIdentity,
}: {
  name: string;
  scope: ScopeId;
  ctx: BindingContext;
  skipSymbol?: SymbolId;
  bindingIdentity?: string;
}): ScopeSymbol[] => {
  const symbols: ScopeSymbol[] = [];
  for (const symbolId of ctx.symbolTable.symbolsNamedInScope(name, scope)) {
    if (symbolId === skipSymbol) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(symbolId);
    if (record.bindingIdentity !== bindingIdentity) {
      continue;
    }
    symbols.push({
      symbolId,
      record,
      span: spanForDeclaredSymbol({ symbol: symbolId, ctx }),
    });
  }
  return symbols;
};

const overloadEntity = (record: SymbolRecord): string | undefined => {
  const metadata = (record.metadata ?? {}) as { entity?: string };
  return metadata.entity;
};

const overloadAllowsSymbol = (record: SymbolRecord): boolean => {
  if (record.kind === "effect-op") {
    return true;
  }
  const entity = overloadEntity(record);
  return entity === "function" || entity === "object";
};

const isModuleNamespaceCollision = ({
  existingKind,
  incomingKind,
}: {
  existingKind: SymbolKind;
  incomingKind: SymbolKind;
}): boolean =>
  (existingKind === "module" && incomingKind !== "module") ||
  (existingKind !== "module" && incomingKind === "module");

export const findNonOverloadNameCollision = ({
  name,
  scope,
  skipSymbol,
  bindingIdentity,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  skipSymbol?: SymbolId;
  bindingIdentity?: string;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({
    name,
    scope,
    skipSymbol,
    bindingIdentity,
    ctx,
  });
  const conflict = symbols.find((entry) => !overloadAllowsSymbol(entry.record));
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

export const findModuleNamespaceNameCollision = ({
  name,
  scope,
  incomingKind,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  incomingKind: SymbolKind;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({
    name,
    scope,
    bindingIdentity: undefined,
    ctx,
  });
  const conflict = symbols.find((entry) =>
    isModuleNamespaceCollision({
      existingKind: entry.record.kind,
      incomingKind,
    }),
  );
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

export const findLocalBindingNameCollision = ({
  name,
  scope,
  bindingIdentity,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  bindingIdentity?: string;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({ name, scope, bindingIdentity, ctx });
  const conflict = symbols.find((entry) => isLocalBinding(entry.record));
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

const isLocalBinding = (record: SymbolRecord): boolean => {
  const metadata = record.metadata as { localBinding?: unknown } | undefined;
  return metadata?.localBinding === true;
};

export const spanForDeclaredSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: BindingContext;
}): SourceSpan => {
  const declaredAt = ctx.symbolTable.getSymbol(symbol).declaredAt;
  return toSourceSpan(ctx.syntaxByNode.get(declaredAt));
};

export const reportOverloadNameCollision = ({
  name,
  scope,
  syntax,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  syntax: Syntax;
  ctx: BindingContext;
}): void => {
  const bindingIdentity = bindingIdentityForSyntax(syntax);
  const bucket = ctx.overloadBuckets.get(
    `${scope}:${bindingIdentity ?? "surface"}:${name}`,
  );
  if (
    !bucket ||
    bucket.functions.length === 0 ||
    bucket.nonFunctionConflictReported
  ) {
    return;
  }
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0003",
      params: { kind: "overload-name-collision", name },
      span: toSourceSpan(syntax),
      related: [
        diagnosticFromCode({
          code: "BD0003",
          params: { kind: "conflicting-declaration" },
          severity: "note",
          span: toSourceSpan(bucket.functions[0]!.form),
        }),
      ],
    }),
  );
  bucket.nonFunctionConflictReported = true;
};
