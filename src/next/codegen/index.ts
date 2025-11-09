import binaryen from "binaryen";
import type { SymbolTable } from "../semantics/binder/index.js";
import type {
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFunction,
  HirGraph,
  HirIfExpr,
} from "../semantics/hir/index.js";
import type {
  HirExprId,
  HirItemId,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypingResult } from "../semantics/typing/pipeline.js";
import type { TypeDescriptor } from "../semantics/typing/type-arena.js";

export interface CodegenOptions {
  optimize?: boolean;
  validate?: boolean;
}

export interface CodegenResult {
  module: binaryen.Module;
}

interface FunctionMetadata {
  symbol: SymbolId;
  wasmName: string;
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
}

interface CodegenContext {
  mod: binaryen.Module;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  options: Required<CodegenOptions>;
  functions: Map<SymbolId, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, SymbolId>;
}

interface LocalBinding {
  index: number;
  type: binaryen.Type;
}

interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  locals: binaryen.Type[];
}

const DEFAULT_OPTIONS: Required<CodegenOptions> = {
  optimize: false,
  validate: true,
};

export const codegen = (
  semantics: SemanticsPipelineResult,
  options: CodegenOptions = {}
): CodegenResult => {
  const mod = new binaryen.Module();
  const ctx: CodegenContext = {
    mod,
    symbolTable: semantics.symbolTable,
    hir: semantics.hir,
    typing: semantics.typing,
    options: { ...DEFAULT_OPTIONS, ...options },
    functions: new Map(),
    itemsToSymbols: new Map(),
  };

  registerFunctionMetadata(ctx);
  compileFunctions(ctx);
  emitExports(ctx);

  if (ctx.options.optimize) {
    mod.optimize();
  }

  if (ctx.options.validate) {
    mod.validate();
  }

  return { module: mod };
};

const registerFunctionMetadata = (ctx: CodegenContext): void => {
  for (const [itemId, item] of ctx.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, item.symbol);

    const scheme = ctx.typing.table.getSymbolScheme(item.symbol);
    if (typeof scheme !== "number") {
      throw new Error(`codegen missing type scheme for function ${item.symbol}`);
    }

    const typeId = ctx.typing.arena.instantiate(scheme, []);
    const descriptor = ctx.typing.arena.get(typeId);
    if (descriptor.kind !== "function") {
      throw new Error(
        `codegen expected function type for symbol ${item.symbol}`
      );
    }

    const paramTypes = descriptor.parameters.map((param) =>
      wasmTypeFor(param.type, ctx)
    );
    const resultType = wasmTypeFor(descriptor.returnType, ctx);

    const metadata: FunctionMetadata = {
      symbol: item.symbol,
      wasmName: makeFunctionName(item, ctx),
      paramTypes,
      resultType,
    };

    ctx.functions.set(item.symbol, metadata);
  }
};

const makeFunctionName = (fn: HirFunction, ctx: CodegenContext): string => {
  const moduleLabel = sanitizeIdentifier(ctx.hir.module.path);
  const symbolName = sanitizeIdentifier(ctx.symbolTable.getSymbol(fn.symbol).name);
  return `${moduleLabel}__${symbolName}_${fn.symbol}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    compileFunctionItem(item, ctx);
  }
};

const compileFunctionItem = (fn: HirFunction, ctx: CodegenContext): void => {
  const meta = ctx.functions.get(fn.symbol);
  if (!meta) {
    throw new Error(`codegen missing metadata for function ${fn.symbol}`);
  }

  const fnCtx: FunctionContext = {
    bindings: new Map(),
    locals: [],
  };

  fn.parameters.forEach((param, index) => {
    const type = meta.paramTypes[index];
    if (typeof type !== "number") {
      throw new Error(
        `codegen missing parameter type for symbol ${param.symbol}`
      );
    }
    fnCtx.bindings.set(param.symbol, { index, type });
  });

  const body = compileExpression(fn.body, ctx, fnCtx);

  ctx.mod.addFunction(
    meta.wasmName,
    binaryen.createType(meta.paramTypes as number[]),
    meta.resultType,
    fnCtx.locals,
    body
  );
};

const emitExports = (ctx: CodegenContext): void => {
  ctx.hir.module.exports.forEach((entry) => {
    const symbol = ctx.itemsToSymbols.get(entry.item);
    if (typeof symbol !== "number") {
      throw new Error("codegen cannot export non-function items yet");
    }
    const meta = ctx.functions.get(symbol);
    if (!meta) {
      throw new Error(`codegen missing metadata for export symbol ${symbol}`);
    }
    const exportName =
      entry.alias ?? ctx.symbolTable.getSymbol(entry.symbol).name;
    ctx.mod.addFunctionExport(meta.wasmName, exportName);
  });
};

const compileExpression = (
  exprId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`codegen missing HirExpression ${exprId}`);
  }

  switch (expr.exprKind) {
    case "literal":
      return compileLiteralExpr(expr, ctx);
    case "identifier":
      return compileIdentifierExpr(expr, ctx, fnCtx);
    case "call":
      return compileCallExpr(expr, ctx, fnCtx);
    case "block":
      return compileBlockExpr(expr, ctx, fnCtx);
    case "if":
      return compileIfExpr(expr, ctx, fnCtx);
    default:
      throw new Error(`codegen does not support ${expr.exprKind} expressions yet`);
  }
};

const compileLiteralExpr = (
  expr: HirExpression & { exprKind: "literal"; literalKind: string; value: string },
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  switch (expr.literalKind) {
    case "i32":
      return ctx.mod.i32.const(Number.parseInt(expr.value, 10));
    case "i64":
      return ctx.mod.i64.const(BigInt(expr.value));
    case "f32":
      return ctx.mod.f32.const(Number.parseFloat(expr.value));
    case "f64":
      return ctx.mod.f64.const(Number.parseFloat(expr.value));
    case "boolean":
      return ctx.mod.i32.const(expr.value === "true" ? 1 : 0);
    case "void":
      return ctx.mod.nop();
    default:
      throw new Error(`codegen does not support literal kind ${expr.literalKind}`);
  }
};

const compileIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const binding = fnCtx.bindings.get(expr.symbol);
  if (!binding) {
    throw new Error(
      `codegen cannot reference symbol ${expr.symbol} in this context`
    );
  }
  return ctx.mod.local.get(binding.index, binding.type);
};

const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const callee = ctx.hir.expressions.get(expr.callee);
  if (!callee || callee.exprKind !== "identifier") {
    throw new Error("codegen only supports direct identifier calls today");
  }

  const args = expr.args.map((arg) => compileExpression(arg, ctx, fnCtx));
  const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = (symbolRecord.metadata ?? {}) as {
    intrinsic?: boolean;
  };

  if (metadata.intrinsic) {
    return compileIntrinsicCall(symbolRecord.name, args, ctx);
  }

  const targetMeta = ctx.functions.get(callee.symbol);
  if (!targetMeta) {
    throw new Error(`codegen cannot call symbol ${symbolRecord.name}`);
  }

  return ctx.mod.call(
    targetMeta.wasmName,
    args,
    getExprBinaryenType(expr.id, ctx)
  );
};

const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const statements: binaryen.ExpressionRef[] = [];
  expr.statements.forEach((stmtId) => {
    statements.push(compileStatement(stmtId, ctx, fnCtx));
  });

  if (typeof expr.value === "number") {
    const valueExpr = compileExpression(expr.value, ctx, fnCtx);
    if (statements.length === 0) {
      return valueExpr;
    }

    statements.push(valueExpr);
    return ctx.mod.block(
      null,
      statements,
      getExprBinaryenType(expr.id, ctx)
    );
  }

  if (statements.length === 0) {
    return ctx.mod.nop();
  }

  return ctx.mod.block(null, statements, binaryen.none);
};

const compileStatement = (
  stmtId: HirStmtId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`codegen missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      return asStatement(ctx, compileExpression(stmt.expr, ctx, fnCtx));
    case "return":
      if (typeof stmt.value === "number") {
        return ctx.mod.return(compileExpression(stmt.value, ctx, fnCtx));
      }
      return ctx.mod.return();
    default:
      throw new Error(`codegen cannot lower statement kind ${stmt.kind}`);
  }
};

const compileIfExpr = (
  expr: HirIfExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const resultType = getExprBinaryenType(expr.id, ctx);
  let fallback =
    typeof expr.defaultBranch === "number"
      ? compileExpression(expr.defaultBranch, ctx, fnCtx)
      : undefined;

  if (!fallback && resultType !== binaryen.none) {
    throw new Error("non-void if expressions require an else branch");
  }

  if (!fallback) {
    fallback = ctx.mod.nop();
  }

  for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
    const branch = expr.branches[index]!;
    const condition = compileExpression(branch.condition, ctx, fnCtx);
    const value = compileExpression(branch.value, ctx, fnCtx);
    fallback = ctx.mod.if(condition, value, fallback);
  }

  return fallback;
};

const compileIntrinsicCall = (
  name: string,
  args: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  switch (name) {
    case "+":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.add(args[0]!, args[1]!);
    case "-":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.sub(args[0]!, args[1]!);
    case "*":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.mul(args[0]!, args[1]!);
    case "/":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.div_s(args[0]!, args[1]!);
    case "<":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.lt_s(args[0]!, args[1]!);
    case "<=":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.le_s(args[0]!, args[1]!);
    case ">":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.gt_s(args[0]!, args[1]!);
    case ">=":
      assertArgCount(name, args, 2);
      return ctx.mod.i32.ge_s(args[0]!, args[1]!);
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

const assertArgCount = (
  name: string,
  args: readonly unknown[],
  expected: number
): void => {
  if (args.length !== expected) {
    throw new Error(
      `intrinsic ${name} expected ${expected} args, received ${args.length}`
    );
  }
};

const asStatement = (
  ctx: CodegenContext,
  expr: binaryen.ExpressionRef
): binaryen.ExpressionRef => {
  const type = binaryen.getExpressionType(expr);
  if (type === binaryen.none || type === binaryen.unreachable) {
    return expr;
  }
  return ctx.mod.drop(expr);
};

const getExprBinaryenType = (
  exprId: HirExprId,
  ctx: CodegenContext
): binaryen.Type => {
  const typeId = ctx.typing.table.getExprType(exprId);
  if (typeof typeId === "number") {
    return wasmTypeFor(typeId, ctx);
  }
  return binaryen.none;
};

const wasmTypeFor = (typeId: TypeId, ctx: CodegenContext): binaryen.Type => {
  const descriptor = ctx.typing.arena.get(typeId);
  return mapTypeDescriptorToWasm(descriptor);
};

const mapTypeDescriptorToWasm = (desc: TypeDescriptor): binaryen.Type => {
  if (desc.kind === "primitive") {
    return mapPrimitiveToWasm(desc.name);
  }

  throw new Error(`codegen cannot map ${desc.kind} types to wasm yet`);
};

const mapPrimitiveToWasm = (name: string): binaryen.Type => {
  switch (name) {
    case "i32":
    case "bool":
    case "boolean":
    case "unknown":
      return binaryen.i32;
    case "i64":
      return binaryen.i64;
    case "f32":
      return binaryen.f32;
    case "f64":
      return binaryen.f64;
    case "voyd":
    case "void":
    case "Voyd":
      return binaryen.none;
    default:
      throw new Error(`unsupported primitive type ${name}`);
  }
};
