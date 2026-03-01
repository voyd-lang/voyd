import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  ModuleLetGetterMetadata,
  SymbolId,
} from "./context.js";
import type { ProgramSymbolId } from "../semantics/ids.js";
import type { HirModuleLet } from "../semantics/hir/index.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";
import { walkHirExpression } from "./hir-walk.js";
import { markDependencyFunctionReachable } from "./function-dependencies.js";

const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const defaultValueForWasmType = (
  wasmType: binaryen.Type,
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (wasmType === binaryen.i32) {
    return ctx.mod.i32.const(0);
  }
  if (wasmType === binaryen.i64) {
    return ctx.mod.i64.const(0, 0);
  }
  if (wasmType === binaryen.f32) {
    return ctx.mod.f32.const(0);
  }
  if (wasmType === binaryen.f64) {
    return ctx.mod.f64.const(0);
  }
  return ctx.mod.ref.null(wasmType);
};

const moduleLetItems = (ctx: CodegenContext): HirModuleLet[] =>
  Array.from(ctx.module.hir.items.values()).filter(
    (item): item is HirModuleLet => item.kind === "module-let",
  );

const localSymbolName = (ctx: CodegenContext, symbol: SymbolId): string =>
  ctx.program.symbols.getName(
    ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol }),
  ) ?? `${symbol}`;

const getterNameFor = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: SymbolId;
}): string =>
  `__module_let__${sanitizeIdentifier(ctx.moduleLabel)}__${sanitizeIdentifier(
    localSymbolName(ctx, symbol),
  )}__${symbol}`;

const resolveImportedSymbol = ({
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

const markInitializerDependenciesReachable = ({
  moduleLet,
  ctx,
}: {
  moduleLet: HirModuleLet;
  ctx: CodegenContext;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const reachable = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = reachable;

  walkHirExpression({
    exprId: moduleLet.initializer,
    ctx,
    visitLambdaBodies: true,
    visitHandlerBodies: true,
    visitor: {
      onExpr: (exprId, expr) => {
        if (expr.exprKind === "literal" && expr.literalKind === "string") {
          markDependencyFunctionReachable({
            ctx,
            dependency: "string-literal-constructor",
            reachable,
          });
          return;
        }

        if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
          return;
        }
        const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
        callInfo.targets?.forEach((targetId) => {
          reachable.add(targetId as ProgramSymbolId);
        });

        if (expr.exprKind !== "call") {
          return;
        }
        const callee = ctx.module.hir.expressions.get(expr.callee);
        if (callee?.exprKind !== "identifier") {
          return;
        }
        const resolved = resolveImportedSymbol({
          ctx,
          moduleId: ctx.moduleId,
          symbol: callee.symbol,
        });
        reachable.add(
          ctx.program.symbols.canonicalIdOf(
            resolved.moduleId,
            resolved.symbol,
          ) as ProgramSymbolId,
        );
      },
    },
  });
};

const computeModuleLetGetterMetadata = ({
  moduleLet,
  ctx,
}: {
  moduleLet: HirModuleLet;
  ctx: CodegenContext;
}): ModuleLetGetterMetadata => {
  const typeId = ctx.module.types.getValueType(moduleLet.symbol);
  if (typeof typeId !== "number") {
    throw new Error(
      `codegen missing type information for module let ${moduleLet.symbol}`,
    );
  }

  const wasmType = wasmTypeFor(typeId, ctx, new Set(), "signature");
  if (wasmType === binaryen.none) {
    throw new Error(`module let ${moduleLet.symbol} cannot have void type`);
  }

  return {
    moduleId: ctx.moduleId,
    symbol: moduleLet.symbol,
    wasmName: getterNameFor({ ctx, symbol: moduleLet.symbol }),
    typeId,
    wasmType,
  };
};

const compileModuleLetGetter = ({
  moduleLet,
  metadata,
  ctx,
}: {
  moduleLet: HirModuleLet;
  metadata: ModuleLetGetterMetadata;
  ctx: CodegenContext;
}): void => {
  const { wasmName, typeId, wasmType } = metadata;
  const readyGlobal = `${wasmName}__ready`;
  const valueGlobal = `${wasmName}__value`;

  ctx.mod.addGlobal(readyGlobal, binaryen.i32, true, ctx.mod.i32.const(0));
  ctx.mod.addGlobal(
    valueGlobal,
    wasmType,
    true,
    defaultValueForWasmType(wasmType, ctx),
  );

  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: 0,
    returnTypeId: typeId,
    returnWasmType: wasmType,
    effectful: false,
  };

  const initializer = compileExpression({
    exprId: moduleLet.initializer,
    ctx,
    fnCtx,
    expectedResultTypeId: typeId,
  });

  const initializeBranch = ctx.mod.block(
    null,
    [
      ctx.mod.global.set(valueGlobal, initializer.expr),
      ctx.mod.global.set(readyGlobal, ctx.mod.i32.const(1)),
      ctx.mod.global.get(valueGlobal, wasmType),
    ],
    wasmType,
  );

  const body = ctx.mod.if(
    ctx.mod.i32.eq(ctx.mod.global.get(readyGlobal, binaryen.i32), ctx.mod.i32.const(1)),
    ctx.mod.global.get(valueGlobal, wasmType),
    initializeBranch,
  );

  ctx.mod.addFunction(wasmName, binaryen.none, wasmType, fnCtx.locals, body);
};

export const registerModuleLetGetters = (ctx: CodegenContext): void => {
  const moduleLets = moduleLetItems(ctx);
  if (moduleLets.length === 0) {
    return;
  }

  const bySymbol =
    ctx.moduleLetGetters.get(ctx.moduleId) ??
    new Map<SymbolId, ModuleLetGetterMetadata>();
  ctx.moduleLetGetters.set(ctx.moduleId, bySymbol);

  moduleLets.forEach((moduleLet) => {
    const metadata = bySymbol.get(moduleLet.symbol);
    if (!metadata) {
      throw new Error(
        `module let getter metadata not pre-registered for ${moduleLet.symbol}`,
      );
    }
    if (ctx.mod.getFunction(metadata.wasmName) !== 0) {
      return;
    }
    compileModuleLetGetter({ moduleLet, metadata, ctx });
    markInitializerDependenciesReachable({ moduleLet, ctx });
  });
};

export const preRegisterModuleLetGetters = (
  contexts: readonly CodegenContext[],
): void => {
  contexts.forEach((ctx) => {
    const moduleLets = moduleLetItems(ctx);
    if (moduleLets.length === 0) {
      return;
    }
    const bySymbol =
      ctx.moduleLetGetters.get(ctx.moduleId) ??
      new Map<SymbolId, ModuleLetGetterMetadata>();
    ctx.moduleLetGetters.set(ctx.moduleId, bySymbol);
    moduleLets.forEach((moduleLet) => {
      if (bySymbol.has(moduleLet.symbol)) {
        return;
      }
      bySymbol.set(
        moduleLet.symbol,
        computeModuleLetGetterMetadata({ moduleLet, ctx }),
      );
    });
  });
};

export const resolveModuleLetGetter = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
}): ModuleLetGetterMetadata | undefined =>
  ctx.moduleLetGetters.get(moduleId)?.get(symbol);
