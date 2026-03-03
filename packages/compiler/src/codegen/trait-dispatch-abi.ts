import type { CodegenContext, SymbolId } from "./context.js";
import { traitDispatchSignatureKey } from "./trait-dispatch-key.js";
import type { ProgramSymbolId } from "../semantics/ids.js";

export const resolveImportedFunctionSymbol = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
}): { moduleId: string; symbol: SymbolId } => {
  const seen = new Set<string>();
  let currentModuleId = moduleId;
  let currentSymbol = symbol;

  while (true) {
    const key = `${currentModuleId}:${currentSymbol}`;
    if (seen.has(key)) {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    seen.add(key);
    const targetId = ctx.program.imports.getTarget(currentModuleId, currentSymbol);
    if (typeof targetId !== "number") {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    const targetRef = ctx.program.symbols.refOf(targetId);
    currentModuleId = targetRef.moduleId;
    currentSymbol = targetRef.symbol;
  }
};

const DISPATCH_EFFECTFUL_CACHE = Symbol.for("voyd.codegen.traitDispatchEffectful");

const isTraitMethodSymbolEffectful = ({
  traitMethodSymbol,
  ctx,
}: {
  traitMethodSymbol: ProgramSymbolId;
  ctx: CodegenContext;
}): boolean => {
  const traitMethodRef = ctx.program.symbols.refOf(traitMethodSymbol);
  const resolvedTraitMethodRef = resolveImportedFunctionSymbol({
    ctx,
    moduleId: traitMethodRef.moduleId,
    symbol: traitMethodRef.symbol,
  });
  const methodMetas = ctx.functions
    .get(resolvedTraitMethodRef.moduleId)
    ?.get(resolvedTraitMethodRef.symbol);
  return methodMetas?.some((meta) => meta.effectful) ?? false;
};

export const isTraitDispatchMethodEffectful = ({
  traitSymbol,
  traitMethodSymbol,
  ctx,
}: {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
  ctx: CodegenContext;
}): boolean => {
  const key = traitDispatchSignatureKey({ traitSymbol, traitMethodSymbol });
  const cache = ctx.programHelpers.getHelperState<{
    bySignature: Map<string, boolean>;
  }>(DISPATCH_EFFECTFUL_CACHE, () => ({ bySignature: new Map() }));
  const cached = cache.bySignature.get(key);
  if (typeof cached === "boolean") {
    return cached;
  }

  const traitMethodEffectful = isTraitMethodSymbolEffectful({
    traitMethodSymbol,
    ctx,
  });
  if (traitMethodEffectful) {
    cache.bySignature.set(key, true);
    return true;
  }

  const value = ctx.program.traits.getImplsByTrait(traitSymbol).some((impl) =>
    impl.methods.some(({ traitMethod, implMethod }) => {
      const traitMethodImpl = ctx.program.traits.getTraitMethodImpl(
        implMethod as ProgramSymbolId,
      );
      const mappedTraitSymbol = traitMethodImpl?.traitSymbol ?? impl.traitSymbol;
      const mappedTraitMethod = traitMethodImpl?.traitMethodSymbol ?? traitMethod;
      if (
        mappedTraitSymbol !== traitSymbol ||
        mappedTraitMethod !== traitMethodSymbol
      ) {
        return false;
      }
      const implRef = ctx.program.symbols.refOf(implMethod as ProgramSymbolId);
      const resolvedImplRef = resolveImportedFunctionSymbol({
        ctx,
        moduleId: implRef.moduleId,
        symbol: implRef.symbol,
      });
      const effectsInfo = ctx.program.modules.get(resolvedImplRef.moduleId)?.effectsInfo;
      return effectsInfo?.functions.get(resolvedImplRef.symbol)?.pure === false;
    }),
  );
  cache.bySignature.set(key, value);
  return value;
};
