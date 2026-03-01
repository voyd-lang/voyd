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
      onExpr: (_exprId, expr) => {
        if (expr.exprKind !== "call") {
          return;
        }
        const callee = ctx.module.hir.expressions.get(expr.callee);
        if (!callee || callee.exprKind !== "identifier") {
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

const compileModuleLetGetter = ({
  moduleLet,
  ctx,
}: {
  moduleLet: HirModuleLet;
  ctx: CodegenContext;
}): ModuleLetGetterMetadata => {
  const typeId = ctx.module.types.getValueType(moduleLet.symbol);
  if (typeof typeId !== "number") {
    throw new Error(`codegen missing type information for module let ${moduleLet.symbol}`);
  }

  const wasmType = wasmTypeFor(typeId, ctx, new Set(), "signature");
  if (wasmType === binaryen.none) {
    throw new Error(`module let ${moduleLet.symbol} cannot have void type`);
  }

  const wasmName = getterNameFor({ ctx, symbol: moduleLet.symbol });
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

  return {
    moduleId: ctx.moduleId,
    symbol: moduleLet.symbol,
    wasmName,
    typeId,
    wasmType,
  };
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
    if (bySymbol.has(moduleLet.symbol)) {
      return;
    }
    const getter = compileModuleLetGetter({ moduleLet, ctx });
    bySymbol.set(moduleLet.symbol, getter);
    markInitializerDependenciesReachable({ moduleLet, ctx });
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
