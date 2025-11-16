import binaryen from "binaryen";
import type { SymbolTable } from "../semantics/binder/index.js";
import type {
  HirAssignExpr,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFunction,
  HirGraph,
  HirIfExpr,
  HirLetStatement,
  HirPattern,
  HirWhileExpr,
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
  nextLocalIndex: number;
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
      throw new Error(
        `codegen missing type scheme for function ${item.symbol}`
      );
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
  const symbolName = sanitizeIdentifier(
    ctx.symbolTable.getSymbol(fn.symbol).name
  );
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
    nextLocalIndex: meta.paramTypes.length,
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
    case "overload-set":
      throw new Error("overload sets cannot be evaluated directly");
    case "call":
      return compileCallExpr(expr, ctx, fnCtx);
    case "block":
      return compileBlockExpr(expr, ctx, fnCtx);
    case "if":
      return compileIfExpr(expr, ctx, fnCtx);
    case "while":
      return compileWhileExpr(expr, ctx, fnCtx);
    case "assign":
      return compileAssignExpr(expr, ctx, fnCtx);
    case "tuple":
      throw new Error("tuple expressions cannot be evaluated directly");
    default:
      throw new Error(
        `codegen does not support ${expr.exprKind} expressions yet`
      );
  }
};

const compileLiteralExpr = (
  expr: HirExpression & {
    exprKind: "literal";
    literalKind: string;
    value: string;
  },
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  switch (expr.literalKind) {
    case "i32":
      return ctx.mod.i32.const(Number.parseInt(expr.value, 10));
    case "i64": {
      const value = BigInt(expr.value);
      const low = Number(value & BigInt(0xffffffff));
      const high = Number((value >> BigInt(32)) & BigInt(0xffffffff));
      return ctx.mod.i64.const(low, high);
    }
    case "f32":
      return ctx.mod.f32.const(Number.parseFloat(expr.value));
    case "f64":
      return ctx.mod.f64.const(Number.parseFloat(expr.value));
    case "boolean":
      return ctx.mod.i32.const(expr.value === "true" ? 1 : 0);
    case "void":
      return ctx.mod.nop();
    default:
      throw new Error(
        `codegen does not support literal kind ${expr.literalKind}`
      );
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
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  const args = expr.args.map((arg) => compileExpression(arg.expr, ctx, fnCtx));

  if (callee.exprKind === "overload-set") {
    const targetSymbol = ctx.typing.callTargets.get(expr.id);
    if (typeof targetSymbol !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    return emitResolvedCall(targetSymbol, args, expr.id, ctx);
  }

  if (callee.exprKind !== "identifier") {
    throw new Error("codegen only supports direct identifier calls today");
  }

  const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = (symbolRecord.metadata ?? {}) as {
    intrinsic?: boolean;
  };

  if (metadata.intrinsic) {
    return compileIntrinsicCall(symbolRecord.name, expr, args, ctx);
  }

  return emitResolvedCall(callee.symbol, args, expr.id, ctx);
};

const emitResolvedCall = (
  symbol: SymbolId,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const symbolRecord = ctx.symbolTable.getSymbol(symbol);
  const targetMeta = ctx.functions.get(symbol);
  if (!targetMeta) {
    throw new Error(`codegen cannot call symbol ${symbolRecord.name}`);
  }

  return ctx.mod.call(
    targetMeta.wasmName,
    args as number[],
    getExprBinaryenType(callId, ctx)
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
    return ctx.mod.block(null, statements, getExprBinaryenType(expr.id, ctx));
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
    case "let":
      return compileLetStatement(stmt, ctx, fnCtx);
    default:
      const unreachable: never = stmt;
      throw new Error(`codegen cannot lower statement kind ${stmt}`);
  }
};

const compileLetStatement = (
  stmt: HirLetStatement,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const ops: binaryen.ExpressionRef[] = [];
  compilePatternInitialization(
    stmt.pattern,
    stmt.initializer,
    ctx,
    fnCtx,
    ops,
    { declare: true }
  );
  if (ops.length === 0) {
    return ctx.mod.nop();
  }
  return ctx.mod.block(null, ops, binaryen.none);
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

const compileWhileExpr = (
  expr: HirWhileExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(compileExpression(expr.condition, ctx, fnCtx)),
    ctx.mod.br(breakLabel)
  );

  const body = asStatement(ctx, compileExpression(expr.body, ctx, fnCtx));
  const loopBody = ctx.mod.block(null, [
    conditionCheck,
    body,
    ctx.mod.br(loopLabel),
  ]);

  return ctx.mod.block(
    breakLabel,
    [ctx.mod.loop(loopLabel, loopBody)],
    binaryen.none
  );
};

const compileAssignExpr = (
  expr: HirAssignExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (expr.pattern) {
    const ops: binaryen.ExpressionRef[] = [];
    compilePatternInitialization(expr.pattern, expr.value, ctx, fnCtx, ops, {
      declare: false,
    });
    return ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryen.none);
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetExpr = ctx.hir.expressions.get(expr.target);
  if (!targetExpr || targetExpr.exprKind !== "identifier") {
    throw new Error("only identifier assignments are supported today");
  }

  const binding = getRequiredBinding(targetExpr.symbol, ctx, fnCtx);
  return ctx.mod.local.set(
    binding.index,
    compileExpression(expr.value, ctx, fnCtx)
  );
};

interface PatternInitOptions {
  declare: boolean;
}

const compilePatternInitialization = (
  pattern: HirPattern,
  initializer: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  ops: binaryen.ExpressionRef[],
  options: PatternInitOptions
): void => {
  if (pattern.kind === "tuple") {
    compileTuplePattern(pattern, initializer, ctx, fnCtx, ops, options);
    return;
  }

  if (pattern.kind === "wildcard") {
    ops.push(asStatement(ctx, compileExpression(initializer, ctx, fnCtx)));
    return;
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  const binding = options.declare
    ? declareLocal(pattern.symbol, ctx, fnCtx)
    : getRequiredBinding(pattern.symbol, ctx, fnCtx);

  ops.push(
    ctx.mod.local.set(binding.index, compileExpression(initializer, ctx, fnCtx))
  );
};

interface PendingTupleAssignment {
  pattern: Extract<HirPattern, { kind: "identifier" }>;
  tempIndex: number;
  tempType: binaryen.Type;
}

const compileTuplePattern = (
  pattern: HirPattern & { kind: "tuple" },
  initializer: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  ops: binaryen.ExpressionRef[],
  options: PatternInitOptions
): void => {
  const pending = collectTupleAssignments(
    pattern,
    initializer,
    ctx,
    fnCtx,
    ops
  );
  pending.forEach(({ pattern: subPattern, tempIndex, tempType }) => {
    const binding = options.declare
      ? declareLocal(subPattern.symbol, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    ops.push(
      ctx.mod.local.set(binding.index, ctx.mod.local.get(tempIndex, tempType))
    );
  });
};

const collectTupleAssignments = (
  pattern: HirPattern,
  exprId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  ops: binaryen.ExpressionRef[]
): PendingTupleAssignment[] => {
  if (pattern.kind === "tuple") {
    const tupleExpr = getTupleExpression(exprId, ctx);
    if (tupleExpr.elements.length !== pattern.elements.length) {
      throw new Error("tuple pattern arity mismatch");
    }
    const collected: PendingTupleAssignment[] = [];
    tupleExpr.elements.forEach((elementExprId, index) => {
      collected.push(
        ...collectTupleAssignments(
          pattern.elements[index]!,
          elementExprId,
          ctx,
          fnCtx,
          ops
        )
      );
    });
    return collected;
  }

  if (pattern.kind === "wildcard") {
    ops.push(asStatement(ctx, compileExpression(exprId, ctx, fnCtx)));
    return [];
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported tuple sub-pattern ${pattern.kind}`);
  }

  const elementTypeId = ctx.typing.table.getExprType(exprId);
  if (typeof elementTypeId !== "number") {
    throw new Error("missing type for tuple element");
  }

  const temp = allocateTempLocal(wasmTypeFor(elementTypeId, ctx), fnCtx);
  ops.push(
    ctx.mod.local.set(temp.index, compileExpression(exprId, ctx, fnCtx))
  );
  return [
    {
      pattern,
      tempIndex: temp.index,
      tempType: temp.type,
    },
  ];
};

const compileIntrinsicCall = (
  name: string,
  call: HirCallExpr,
  args: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  switch (name) {
    case "+":
    case "-":
    case "*":
    case "/": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx
      );
      return emitArithmeticIntrinsic(name, operandKind, args, ctx);
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx
      );
      return emitComparisonIntrinsic(name, operandKind, args, ctx);
    }
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

type NumericKind = "i32" | "i64" | "f32" | "f64";

const emitArithmeticIntrinsic = (
  op: "+" | "-" | "*" | "/",
  kind: NumericKind,
  args: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "+":
          return ctx.mod.i32.add(left, right);
        case "-":
          return ctx.mod.i32.sub(left, right);
        case "*":
          return ctx.mod.i32.mul(left, right);
        case "/":
          return ctx.mod.i32.div_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "+":
          return ctx.mod.i64.add(left, right);
        case "-":
          return ctx.mod.i64.sub(left, right);
        case "*":
          return ctx.mod.i64.mul(left, right);
        case "/":
          return ctx.mod.i64.div_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "+":
          return ctx.mod.f32.add(left, right);
        case "-":
          return ctx.mod.f32.sub(left, right);
        case "*":
          return ctx.mod.f32.mul(left, right);
        case "/":
          return ctx.mod.f32.div(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "+":
          return ctx.mod.f64.add(left, right);
        case "-":
          return ctx.mod.f64.sub(left, right);
        case "*":
          return ctx.mod.f64.mul(left, right);
        case "/":
          return ctx.mod.f64.div(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} intrinsic for numeric kind ${kind}`);
};

const emitComparisonIntrinsic = (
  op: "<" | "<=" | ">" | ">=",
  kind: NumericKind,
  args: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "<":
          return ctx.mod.i32.lt_s(left, right);
        case "<=":
          return ctx.mod.i32.le_s(left, right);
        case ">":
          return ctx.mod.i32.gt_s(left, right);
        case ">=":
          return ctx.mod.i32.ge_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "<":
          return ctx.mod.i64.lt_s(left, right);
        case "<=":
          return ctx.mod.i64.le_s(left, right);
        case ">":
          return ctx.mod.i64.gt_s(left, right);
        case ">=":
          return ctx.mod.i64.ge_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "<":
          return ctx.mod.f32.lt(left, right);
        case "<=":
          return ctx.mod.f32.le(left, right);
        case ">":
          return ctx.mod.f32.gt(left, right);
        case ">=":
          return ctx.mod.f32.ge(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "<":
          return ctx.mod.f64.lt(left, right);
        case "<=":
          return ctx.mod.f64.le(left, right);
        case ">":
          return ctx.mod.f64.gt(left, right);
        case ">=":
          return ctx.mod.f64.ge(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} comparison for numeric kind ${kind}`);
};

const requireHomogeneousNumericKind = (
  argExprIds: readonly HirExprId[],
  ctx: CodegenContext
): NumericKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getNumericKind(
    getRequiredExprType(argExprIds[0]!, ctx),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getNumericKind(
      getRequiredExprType(argExprIds[i]!, ctx),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same numeric type");
    }
  }
  return firstKind;
};

const getNumericKind = (typeId: TypeId, ctx: CodegenContext): NumericKind => {
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind === "primitive") {
    switch (descriptor.name) {
      case "i32":
        return "i32";
      case "i64":
        return "i64";
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error("intrinsic arguments must be primitive numeric types");
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

const declareLocal = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const typeId = getSymbolTypeId(symbol, ctx);
  const wasmType = wasmTypeFor(typeId, ctx);
  const binding = allocateTempLocal(wasmType, fnCtx);
  fnCtx.bindings.set(symbol, binding);
  return binding;
};

const getRequiredBinding = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const binding = fnCtx.bindings.get(symbol);
  if (!binding) {
    throw new Error(
      `codegen missing binding for symbol ${getSymbolName(symbol, ctx)}`
    );
  }
  return binding;
};

const allocateTempLocal = (
  type: binaryen.Type,
  fnCtx: FunctionContext
): LocalBinding => {
  const binding: LocalBinding = {
    index: fnCtx.nextLocalIndex,
    type,
  };
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return binding;
};

const getSymbolTypeId = (symbol: SymbolId, ctx: CodegenContext): TypeId => {
  const typeId = ctx.typing.valueTypes.get(symbol);
  if (typeof typeId === "number") {
    return typeId;
  }
  throw new Error(
    `codegen missing type information for symbol ${getSymbolName(symbol, ctx)}`
  );
};

const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext
): TypeId => {
  const typeId = ctx.typing.table.getExprType(exprId);
  if (typeof typeId === "number") {
    return typeId;
  }
  throw new Error(`codegen missing type information for expression ${exprId}`);
};

const getTupleExpression = (
  exprId: HirExprId,
  ctx: CodegenContext
): HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] } => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "tuple") {
    throw new Error("tuple pattern requires a tuple initializer expression");
  }
  return expr;
};

const getSymbolName = (symbol: SymbolId, ctx: CodegenContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;

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
