import type { Syntax } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveConstructorResolution } from "../resolution.js";
import type { IdentifierResolution, LowerContext } from "../types.js";
import type { HirExprId, SourceSpan, SymbolId } from "../../ids.js";

type SymbolMetadata = {
  declarationSpan?: unknown;
  import?: { moduleId?: unknown; symbol?: unknown };
};

const isSourceSpan = (value: unknown): value is SourceSpan => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SourceSpan>;
  return (
    typeof candidate.file === "string" &&
    typeof candidate.start === "number" &&
    typeof candidate.end === "number"
  );
};

const isKnownSpan = (span: SourceSpan | undefined): span is SourceSpan =>
  Boolean(span && span.file !== "<unknown>");

const declarationSpanFromDecls = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: LowerContext;
}): SourceSpan | undefined => {
  const fn = ctx.decls.getFunction(symbol);
  if (fn?.form) {
    return toSourceSpan(fn.form);
  }

  const alias = ctx.decls.getTypeAlias(symbol);
  if (alias?.form) {
    return toSourceSpan(alias.form);
  }

  const object = ctx.decls.getObject(symbol);
  if (object?.form) {
    return toSourceSpan(object.form);
  }

  const trait = ctx.decls.getTrait(symbol);
  if (trait?.form) {
    return toSourceSpan(trait.form);
  }

  const effect = ctx.decls.getEffect(symbol);
  if (effect?.form) {
    return toSourceSpan(effect.form);
  }

  const parameter = ctx.decls.getParameter(symbol);
  if (parameter?.ast) {
    return toSourceSpan(parameter.ast);
  }

  const effectOp = ctx.decls.getEffectOperation(symbol);
  if (effectOp?.operation.ast) {
    return toSourceSpan(effectOp.operation.ast);
  }

  return undefined;
};

const importedDeclarationSpan = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: LowerContext;
}): SourceSpan | undefined => {
  const localRecord = ctx.symbolTable.getSymbol(symbol);
  const metadata = localRecord.metadata as SymbolMetadata | undefined;
  if (
    typeof metadata?.import?.moduleId !== "string" ||
    typeof metadata.import.symbol !== "number"
  ) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(metadata.import.moduleId);
  if (!dependency) {
    return undefined;
  }

  const importedSymbol = metadata.import.symbol;
  const fn = dependency.decls.getFunction(importedSymbol);
  if (fn?.form) {
    return toSourceSpan(fn.form);
  }

  const alias = dependency.decls.getTypeAlias(importedSymbol);
  if (alias?.form) {
    return toSourceSpan(alias.form);
  }

  const object = dependency.decls.getObject(importedSymbol);
  if (object?.form) {
    return toSourceSpan(object.form);
  }

  const trait = dependency.decls.getTrait(importedSymbol);
  if (trait?.form) {
    return toSourceSpan(trait.form);
  }

  const effect = dependency.decls.getEffect(importedSymbol);
  if (effect?.form) {
    return toSourceSpan(effect.form);
  }

  const effectOp = dependency.decls.getEffectOperation(importedSymbol);
  if (effectOp?.operation.ast) {
    return toSourceSpan(effectOp.operation.ast);
  }

  return undefined;
};

const declarationSpanForSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: LowerContext;
}): SourceSpan | undefined => {
  const metadata = ctx.symbolTable.getSymbol(symbol).metadata as
    | SymbolMetadata
    | undefined;

  if (isSourceSpan(metadata?.declarationSpan) && isKnownSpan(metadata.declarationSpan)) {
    return metadata.declarationSpan;
  }

  const imported = importedDeclarationSpan({ symbol, ctx });
  if (isKnownSpan(imported)) {
    return imported;
  }

  const importSite = ctx.importSpansByLocal.get(symbol);
  if (isKnownSpan(importSite)) {
    return importSite;
  }

  const local = declarationSpanFromDecls({ symbol, ctx });
  if (isKnownSpan(local)) {
    return local;
  }

  return undefined;
};

const dependencySymbolName = ({
  moduleId,
  symbol,
  fallback,
  ctx,
}: {
  moduleId: string;
  symbol: number | undefined;
  fallback: string;
  ctx: LowerContext;
}): string => {
  if (typeof symbol !== "number") {
    return fallback;
  }

  const dependency = ctx.dependencies.get(moduleId);
  if (!dependency) {
    return fallback;
  }

  try {
    return dependency.symbolTable.getSymbol(symbol).name;
  } catch {
    return fallback;
  }
};

const fullyQualifiedPathForSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: LowerContext;
}): string => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = record.metadata as SymbolMetadata | undefined;
  const importModuleId =
    typeof metadata?.import?.moduleId === "string"
      ? metadata.import.moduleId
      : undefined;

  if (importModuleId) {
    const importedName = dependencySymbolName({
      moduleId: importModuleId,
      symbol:
        typeof metadata?.import?.symbol === "number"
          ? metadata.import.symbol
          : undefined,
      fallback: record.name,
      ctx,
    });
    return `${importModuleId}::${importedName}`;
  }

  return `${ctx.moduleId}::${record.name}`;
};

const formatSourceSpan = (span: SourceSpan): string =>
  `${span.file}:${span.start}-${span.end}`;

const formatAmbiguousCandidates = ({
  symbols,
  ctx,
}: {
  symbols: readonly SymbolId[];
  ctx: LowerContext;
}): string =>
  symbols
    .map((symbol) => {
      const candidatePath = fullyQualifiedPathForSymbol({ symbol, ctx });
      const candidateSpan = declarationSpanForSymbol({ symbol, ctx });
      const location = candidateSpan
        ? ` (${formatSourceSpan(candidateSpan)})`
        : "";
      return `- ${candidatePath} [symbol ${symbol}]${location}`;
    })
    .join("\n");

const formatAmbiguousResolutionMessage = ({
  headline,
  symbols,
  guidance,
  ctx,
}: {
  headline: string;
  symbols: readonly SymbolId[];
  guidance: string;
  ctx: LowerContext;
}): string =>
  `${headline}\nCandidates:\n${formatAmbiguousCandidates({
    symbols,
    ctx,
  })}\n${guidance}`;

export const lowerResolvedCallee = ({
  resolution,
  syntax,
  ctx,
}: {
  resolution: IdentifierResolution;
  syntax: Syntax;
  ctx: LowerContext;
}): HirExprId => {
  const span = toSourceSpan(syntax);
  if (resolution.kind === "symbol") {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "identifier",
      ast: syntax.syntaxId,
      span,
      symbol: resolution.symbol,
    });
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "overload-set",
    ast: syntax.syntaxId,
    span,
    name: resolution.name,
    set: resolution.set,
  });
};

export const resolveStaticMethodResolution = ({
  name,
  targetSymbol,
  methodTable,
  ctx,
}: {
  name: string;
  targetSymbol: SymbolId;
  methodTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution => {
  const symbols = methodTable.get(name);
  if (!symbols || symbols.size === 0) {
    const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
    throw new Error(`type ${targetName} does not declare static method ${name}`);
  }

  if (symbols.size === 1) {
    const symbol = symbols.values().next().value as SymbolId;
    const overload = ctx.overloadBySymbol.get(symbol);
    return typeof overload === "number"
      ? { kind: "overload-set", name, set: overload }
      : { kind: "symbol", name, symbol };
  }

  const symbolsArray = Array.from(symbols);
  let missingOverload = false;
  const overloads = new Set<number>();
  symbolsArray.forEach((symbol) => {
    const overloadId = ctx.overloadBySymbol.get(symbol);
    if (typeof overloadId === "number") {
      overloads.add(overloadId);
      return;
    }
    missingOverload = true;
  });

  if (!missingOverload && overloads.size === 1) {
    return {
      kind: "overload-set",
      name,
      set: overloads.values().next().value as number,
    };
  }

  const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
  throw new Error(
    formatAmbiguousResolutionMessage({
      headline: `ambiguous static method ${name} for type ${targetName}`,
      symbols: symbolsArray,
      guidance: "Use explicit qualification to select a single static method.",
      ctx,
    }),
  );
};

export const resolveModuleMemberResolution = ({
  name,
  moduleSymbol,
  memberTable,
  ctx,
}: {
  name: string;
  moduleSymbol: SymbolId;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution | undefined => {
  const symbols = memberTable.get(name);
  if (!symbols || symbols.size === 0) {
    return undefined;
  }

  if (symbols.size === 1) {
    const symbol = symbols.values().next().value as SymbolId;
    const overload = ctx.overloadBySymbol.get(symbol);
    return typeof overload === "number"
      ? { kind: "overload-set", name, set: overload }
      : { kind: "symbol", name, symbol };
  }

  const overloads = new Set<number>();
  let missing = false;
  symbols.forEach((symbol) => {
    const id = ctx.overloadBySymbol.get(symbol);
    if (typeof id === "number") {
      overloads.add(id);
    } else {
      missing = true;
    }
  });

  if (!missing && overloads.size === 1) {
    return {
      kind: "overload-set",
      name,
      set: overloads.values().next().value as number,
    };
  }

  const moduleName = ctx.symbolTable.getSymbol(moduleSymbol).name;
  throw new Error(
    formatAmbiguousResolutionMessage({
      headline: `ambiguous module member ${name} on ${moduleName}`,
      symbols: Array.from(symbols),
      guidance:
        "Disambiguate by importing with an alias or qualifying the target symbol explicitly.",
      ctx,
    }),
  );
};

export const resolveModuleMemberCallResolution = ({
  name,
  moduleSymbol,
  memberTable,
  ctx,
}: {
  name: string;
  moduleSymbol: SymbolId;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution | undefined => {
  const base = resolveModuleMemberResolution({
    name,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!base) {
    return undefined;
  }
  if (base.kind !== "symbol") {
    return base;
  }
  const record = ctx.symbolTable.getSymbol(base.symbol);
  if (record.kind !== "type") {
    return base;
  }
  const constructor = resolveConstructorResolution({
    targetSymbol: base.symbol,
    name,
    ctx,
  });
  return constructor ?? base;
};
