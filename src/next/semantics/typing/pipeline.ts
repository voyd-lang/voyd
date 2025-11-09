import type { SymbolTable } from "../binder/index.js";
import type {
  HirAssignExpr,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFunction,
  HirGraph,
  HirIfExpr,
  HirLetStatement,
  HirLiteralExpr,
  HirPattern,
  HirTypeExpr,
  HirNamedTypeExpr,
  HirWhileExpr,
} from "../hir/index.js";
import type {
  EffectRowId,
  HirExprId,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../ids.js";
import { createTypeArena, type TypeArena } from "./type-arena.js";
import { createTypeTable, type TypeTable } from "./type-table.js";

interface TypingInputs {
  symbolTable: SymbolTable;
  hir: HirGraph;
}

export interface TypingResult {
  arena: TypeArena;
  table: TypeTable;
  valueTypes: ReadonlyMap<SymbolId, TypeId>;
}

interface FunctionSignature {
  typeId: TypeId;
  parameterTypes: readonly TypeId[];
  returnType: TypeId;
  hasExplicitReturn: boolean;
}

interface TypingContext {
  symbolTable: SymbolTable;
  hir: HirGraph;
  arena: TypeArena;
  table: TypeTable;
  functionSignatures: Map<SymbolId, FunctionSignature>;
  valueTypes: Map<SymbolId, TypeId>;
  primitiveCache: Map<string, TypeId>;
  intrinsicTypes: Map<string, TypeId>;
  boolType: TypeId;
  voidType: TypeId;
  unknownType: TypeId;
  defaultEffectRow: EffectRowId;
}

const DEFAULT_EFFECT_ROW: EffectRowId = 0;

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const arena = createTypeArena();
  const table = createTypeTable();

  const ctx: TypingContext = {
    symbolTable: inputs.symbolTable,
    hir: inputs.hir,
    arena,
    table,
    functionSignatures: new Map(),
    valueTypes: new Map(),
    primitiveCache: new Map(),
    intrinsicTypes: new Map(),
    boolType: 0,
    voidType: 0,
    unknownType: 0,
    defaultEffectRow: DEFAULT_EFFECT_ROW,
  };

  seedPrimitiveTypes(ctx);
  registerFunctionSignatures(ctx);

  for (const item of inputs.hir.items.values()) {
    if (item.kind !== "function") continue;
    typeFunction(item, ctx);
  }

  return { arena, table, valueTypes: new Map(ctx.valueTypes) };
};

const seedPrimitiveTypes = (ctx: TypingContext): void => {
  ctx.voidType = registerPrimitive(ctx, "voyd", "void", "Voyd");
  ctx.boolType = registerPrimitive(ctx, "bool", "boolean", "Bool");
  ctx.unknownType = registerPrimitive(ctx, "unknown");

  registerPrimitive(ctx, "i32");
  registerPrimitive(ctx, "i64");
  registerPrimitive(ctx, "f32");
  registerPrimitive(ctx, "f64");
  registerPrimitive(ctx, "string", "String");
};

const registerFunctionSignatures = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;

    const parameterTypes = item.parameters.map((param) => {
      const resolved = resolveTypeExpr(param.type, ctx, ctx.unknownType);
      ctx.valueTypes.set(param.symbol, resolved);
      return resolved;
    });

    const hasExplicitReturn = Boolean(item.returnType);
    const declaredReturn =
      resolveTypeExpr(item.returnType, ctx, ctx.voidType) ?? ctx.voidType;

    const functionType = ctx.arena.internFunction({
      parameters: parameterTypes.map((type) => ({ type, optional: false })),
      returnType: declaredReturn,
      effects: ctx.defaultEffectRow,
    });

    ctx.functionSignatures.set(item.symbol, {
      typeId: functionType,
      parameterTypes,
      returnType: declaredReturn,
      hasExplicitReturn,
    });
    ctx.valueTypes.set(item.symbol, functionType);

    const scheme = ctx.arena.newScheme([], functionType);
    ctx.table.setSymbolScheme(item.symbol, scheme);
  }
};

const typeFunction = (fn: HirFunction, ctx: TypingContext): void => {
  const signature = ctx.functionSignatures.get(fn.symbol);
  if (!signature) {
    throw new Error(`missing type signature for function symbol ${fn.symbol}`);
  }

  const bodyType = typeExpression(fn.body, ctx);
  if (signature.hasExplicitReturn) {
    ensureTypeMatches(
      bodyType,
      signature.returnType,
      `function ${getSymbolName(fn.symbol, ctx)} return type`
    );
    return;
  }

  finalizeFunctionReturnType(fn, signature, bodyType, ctx);
};

const finalizeFunctionReturnType = (
  fn: HirFunction,
  signature: FunctionSignature,
  inferred: TypeId,
  ctx: TypingContext
): void => {
  signature.returnType = inferred;
  const functionType = ctx.arena.internFunction({
    parameters: signature.parameterTypes.map((type) => ({
      type,
      optional: false,
    })),
    returnType: inferred,
    effects: ctx.defaultEffectRow,
  });
  signature.typeId = functionType;
  ctx.valueTypes.set(fn.symbol, functionType);
  const scheme = ctx.arena.newScheme([], functionType);
  ctx.table.setSymbolScheme(fn.symbol, scheme);
};

const typeExpression = (exprId: HirExprId, ctx: TypingContext): TypeId => {
  const cached = ctx.table.getExprType(exprId);
  if (typeof cached === "number") {
    return cached;
  }

  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`missing HirExpression ${exprId}`);
  }

  let type: TypeId;
  switch (expr.exprKind) {
    case "literal":
      type = typeLiteralExpr(expr, ctx);
      break;
    case "identifier":
      type = typeIdentifierExpr(expr, ctx);
      break;
    case "call":
      type = typeCallExpr(expr, ctx);
      break;
    case "block":
      type = typeBlockExpr(expr, ctx);
      break;
    case "if":
      type = typeIfExpr(expr, ctx);
      break;
    case "tuple":
      type = typeTupleExpr(expr, ctx);
      break;
    case "while":
      type = typeWhileExpr(expr, ctx);
      break;
    case "assign":
      type = typeAssignExpr(expr, ctx);
      break;
    default:
      throw new Error(`unsupported expression kind: ${expr.exprKind}`);
  }

  ctx.table.setExprType(exprId, type);
  return type;
};

const typeLiteralExpr = (expr: HirLiteralExpr, ctx: TypingContext): TypeId => {
  switch (expr.literalKind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64":
      return getPrimitiveType(ctx, expr.literalKind);
    case "string":
      return getPrimitiveType(ctx, "string");
    case "boolean":
      return ctx.boolType;
    case "void":
      return ctx.voidType;
    default:
      throw new Error(`unsupported literal kind: ${expr.literalKind}`);
  }
};

const typeIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: TypingContext
): TypeId => getValueType(expr.symbol, ctx);

const typeCallExpr = (expr: HirCallExpr, ctx: TypingContext): TypeId => {
  if (expr.typeArguments && expr.typeArguments.length > 0) {
    throw new Error("polymorphic calls are not supported yet");
  }

  const calleeType = typeExpression(expr.callee, ctx);
  const calleeDesc = ctx.arena.get(calleeType);
  if (calleeDesc.kind !== "function") {
    throw new Error("attempted to call a non-function value");
  }

  if (expr.args.length !== calleeDesc.parameters.length) {
    throw new Error("call argument count mismatch");
  }

  expr.args.forEach((argId, index) => {
    const argType = typeExpression(argId, ctx);
    const param = calleeDesc.parameters[index];
    ensureTypeMatches(argType, param.type, `call argument ${index + 1}`);
  });

  return calleeDesc.returnType;
};

const typeBlockExpr = (expr: HirBlockExpr, ctx: TypingContext): TypeId => {
  expr.statements.forEach((stmtId) => typeStatement(stmtId, ctx));
  if (typeof expr.value === "number") {
    return typeExpression(expr.value, ctx);
  }
  return ctx.voidType;
};

const typeStatement = (stmtId: HirStmtId, ctx: TypingContext): void => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      typeExpression(stmt.expr, ctx);
      return;
    case "return":
      if (typeof stmt.value === "number") {
        typeExpression(stmt.value, ctx);
      }
      return;
    case "let":
      typeLetStatement(stmt, ctx);
      return;
    default: {
      const unreachable: never = stmt;
      throw new Error("unsupported statement kind");
    }
  }
};

const typeLetStatement = (stmt: HirLetStatement, ctx: TypingContext): void => {
  if (stmt.pattern.kind === "tuple") {
    bindTuplePatternFromExpr(stmt.pattern, stmt.initializer, ctx, "declare");
    return;
  }

  const initializerType = typeExpression(stmt.initializer, ctx);
  recordPatternType(stmt.pattern, initializerType, ctx, "declare");
};

const typeIfExpr = (expr: HirIfExpr, ctx: TypingContext): TypeId => {
  let branchType: TypeId | undefined;

  expr.branches.forEach((branch, index) => {
    const conditionType = typeExpression(branch.condition, ctx);
    ensureTypeMatches(conditionType, ctx.boolType, `if condition ${index + 1}`);

    const valueType = typeExpression(branch.value, ctx);
    branchType = mergeBranchType(branchType, valueType);
  });

  if (typeof expr.defaultBranch === "number") {
    const defaultType = typeExpression(expr.defaultBranch, ctx);
    branchType = mergeBranchType(branchType, defaultType);
  }

  return branchType ?? ctx.voidType;
};

const typeTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: TypingContext
): TypeId => {
  expr.elements.forEach((elementId) => typeExpression(elementId, ctx));
  return ctx.unknownType;
};

const typeWhileExpr = (expr: HirWhileExpr, ctx: TypingContext): TypeId => {
  const conditionType = typeExpression(expr.condition, ctx);
  ensureTypeMatches(conditionType, ctx.boolType, "while condition");
  typeExpression(expr.body, ctx);
  return ctx.voidType;
};

const typeAssignExpr = (expr: HirAssignExpr, ctx: TypingContext): TypeId => {
  if (expr.pattern) {
    typeTupleAssignment(expr.pattern, expr.value, ctx);
    return ctx.voidType;
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetType = typeExpression(expr.target, ctx);
  const valueType = typeExpression(expr.value, ctx);
  ensureTypeMatches(valueType, targetType, "assignment target");
  return ctx.voidType;
};

const typeTupleAssignment = (
  pattern: HirPattern,
  valueExpr: HirExprId,
  ctx: TypingContext
): void => {
  if (pattern.kind !== "tuple") {
    throw new Error("tuple assignment requires a tuple pattern");
  }
  bindTuplePatternFromExpr(pattern, valueExpr, ctx, "assign");
};

const mergeBranchType = (acc: TypeId | undefined, next: TypeId): TypeId => {
  if (typeof acc === "number" && acc !== next) {
    throw new Error("branch type mismatch");
  }
  return typeof acc === "number" ? acc : next;
};

const getValueType = (symbol: SymbolId, ctx: TypingContext): TypeId => {
  const cached = ctx.valueTypes.get(symbol);
  if (typeof cached === "number") {
    return cached;
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as { intrinsic?: boolean };

  if (metadata.intrinsic) {
    const intrinsicType = getIntrinsicType(record.name, ctx);
    ctx.valueTypes.set(symbol, intrinsicType);

    if (!ctx.table.getSymbolScheme(symbol)) {
      const scheme = ctx.arena.newScheme([], intrinsicType);
      ctx.table.setSymbolScheme(symbol, scheme);
    }

    return intrinsicType;
  }

  throw new Error(`missing value type for symbol ${record.name}`);
};

const getIntrinsicType = (name: string, ctx: TypingContext): TypeId => {
  const cached = ctx.intrinsicTypes.get(name);
  if (typeof cached === "number") {
    return cached;
  }

  const signature = intrinsicSignatureFor(name, ctx);
  if (!signature) {
    throw new Error(`unsupported intrinsic ${name}`);
  }

  const fnType = ctx.arena.internFunction({
    parameters: signature.parameters.map((type) => ({
      type,
      optional: false,
    })),
    returnType: signature.returnType,
    effects: ctx.defaultEffectRow,
  });

  ctx.intrinsicTypes.set(name, fnType);
  return fnType;
};

interface IntrinsicSignature {
  parameters: readonly TypeId[];
  returnType: TypeId;
}

const intrinsicSignatureFor = (
  name: string,
  ctx: TypingContext
): IntrinsicSignature | undefined => {
  const int32 = getPrimitiveType(ctx, "i32");
  switch (name) {
    case "+":
    case "-":
    case "*":
    case "/":
      return { parameters: [int32, int32], returnType: int32 };
    case "<":
    case "<=":
    case ">":
    case ">=":
      return { parameters: [int32, int32], returnType: ctx.boolType };
    default:
      return undefined;
  }
};

const resolveTypeExpr = (
  expr: HirTypeExpr | undefined,
  ctx: TypingContext,
  fallback: TypeId
): TypeId => {
  if (!expr) {
    return fallback;
  }

  switch (expr.typeKind) {
    case "named":
      return resolveNamedTypeExpr(expr, ctx);
    default:
      throw new Error(`unsupported type expression kind: ${expr.typeKind}`);
  }
};

const resolveNamedTypeExpr = (
  expr: HirNamedTypeExpr,
  ctx: TypingContext
): TypeId => {
  if (expr.path.length !== 1) {
    throw new Error("qualified type paths are not supported yet");
  }

  if (expr.typeArguments && expr.typeArguments.length > 0) {
    throw new Error("generic type expressions are not supported yet");
  }

  const name = expr.path[0]!;
  const resolved = ctx.primitiveCache.get(name);
  if (typeof resolved === "number") {
    return resolved;
  }

  return getPrimitiveType(ctx, name);
};

const registerPrimitive = (
  ctx: TypingContext,
  canonical: string,
  ...aliases: string[]
): TypeId => {
  let id = ctx.primitiveCache.get(canonical);
  if (typeof id !== "number") {
    id = ctx.arena.internPrimitive(canonical);
  }
  ctx.primitiveCache.set(canonical, id);
  aliases.forEach((alias) => ctx.primitiveCache.set(alias, id));
  return id;
};

const getPrimitiveType = (ctx: TypingContext, name: string): TypeId => {
  const cached = ctx.primitiveCache.get(name);
  if (typeof cached === "number") {
    return cached;
  }
  return registerPrimitive(ctx, name);
};

type PatternBindingMode = "declare" | "assign";

const bindTuplePatternFromExpr = (
  pattern: HirPattern & { kind: "tuple" },
  exprId: HirExprId,
  ctx: TypingContext,
  mode: PatternBindingMode
): void => {
  const tupleExpr = getTupleExpression(exprId, ctx);
  if (tupleExpr.elements.length !== pattern.elements.length) {
    throw new Error("tuple pattern length mismatch");
  }

  pattern.elements.forEach((subPattern, index) => {
    const elementExprId = tupleExpr.elements[index]!;
    if (subPattern.kind === "tuple") {
      bindTuplePatternFromExpr(subPattern, elementExprId, ctx, mode);
      return;
    }
    const elementType = typeExpression(elementExprId, ctx);
    recordPatternType(subPattern, elementType, ctx, mode);
  });
};

const recordPatternType = (
  pattern: HirPattern,
  type: TypeId,
  ctx: TypingContext,
  mode: PatternBindingMode
): void => {
  switch (pattern.kind) {
    case "identifier": {
      if (mode === "declare" || !ctx.valueTypes.has(pattern.symbol)) {
        ctx.valueTypes.set(pattern.symbol, type);
        return;
      }
      const existing = ctx.valueTypes.get(pattern.symbol);
      if (typeof existing !== "number") {
        throw new Error(
          `missing type for identifier ${getSymbolName(pattern.symbol, ctx)}`
        );
      }
      ensureTypeMatches(
        type,
        existing,
        `assignment to ${getSymbolName(pattern.symbol, ctx)}`
      );
      return;
    }
    case "wildcard":
      return;
    default:
      throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }
};

const getTupleExpression = (
  exprId: HirExprId,
  ctx: TypingContext
): HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] } => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "tuple") {
    throw new Error("tuple pattern requires a tuple initializer");
  }
  return expr;
};

const ensureTypeMatches = (
  actual: TypeId,
  expected: TypeId,
  reason: string
): void => {
  if (actual !== expected) {
    throw new Error(`type mismatch for ${reason}`);
  }
};

const getSymbolName = (symbol: SymbolId, ctx: TypingContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;
