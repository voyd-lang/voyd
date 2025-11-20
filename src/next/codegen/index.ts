import binaryen from "binaryen";
import type { SymbolTable } from "../semantics/binder/index.js";
import type {
  HirAssignExpr,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFieldAccessExpr,
  HirFunction,
  HirGraph,
  HirIfExpr,
  HirMatchExpr,
  HirLetStatement,
  HirObjectLiteralExpr,
  HirPattern,
  HirTypeExpr,
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
import {
  callRef,
  defineStructType,
  initStruct,
  refCast,
  structGetFieldValue,
  binaryenTypeToHeapType,
} from "../../lib/binaryen-gc/index.js";
import {
  createRttContext,
  RTT_METADATA_SLOTS,
  RTT_METADATA_SLOT_COUNT,
  LOOKUP_FIELD_ACCESSOR,
} from "./rtt/index.js";

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
  paramTypeIds: readonly TypeId[];
  resultTypeId: TypeId;
}

interface CodegenContext {
  mod: binaryen.Module;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  options: Required<CodegenOptions>;
  functions: Map<SymbolId, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, SymbolId>;
  structTypes: Map<TypeId, StructuralTypeInfo>;
  rtt: ReturnType<typeof createRttContext>;
}

interface LocalBinding {
  index: number;
  type: binaryen.Type;
}

interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  locals: binaryen.Type[];
  nextLocalIndex: number;
  returnTypeId: TypeId;
}

interface CompiledExpression {
  expr: binaryen.ExpressionRef;
  usedReturnCall: boolean;
}

interface CompileCallOptions {
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
}
interface StructuralFieldInfo {
  name: string;
  typeId: TypeId;
  wasmType: binaryen.Type;
  runtimeIndex: number;
  hash: number;
  getterType?: binaryen.Type;
  setterType?: binaryen.Type;
}

interface StructuralTypeInfo {
  typeId: TypeId;
  runtimeType: binaryen.Type;
  interfaceType: binaryen.Type;
  fields: StructuralFieldInfo[];
  fieldMap: Map<string, StructuralFieldInfo>;
  ancestorsGlobal: string;
  fieldTableGlobal: string;
  methodTableGlobal: string;
  typeLabel: string;
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
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const ctx: CodegenContext = {
    mod,
    symbolTable: semantics.symbolTable,
    hir: semantics.hir,
    typing: semantics.typing,
    options: { ...DEFAULT_OPTIONS, ...options },
    functions: new Map(),
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    rtt,
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
      paramTypeIds: descriptor.parameters.map((param) => param.type),
      resultTypeId: descriptor.returnType,
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
    returnTypeId: meta.resultTypeId,
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

  const body = compileExpression(fn.body, ctx, fnCtx, true, fnCtx.returnTypeId);

  ctx.mod.addFunction(
    meta.wasmName,
    binaryen.createType(meta.paramTypes as number[]),
    meta.resultType,
    fnCtx.locals,
    body.expr
  );
};

const emitExports = (ctx: CodegenContext): void => {
  ctx.hir.module.exports.forEach((entry) => {
    const symbol = ctx.itemsToSymbols.get(entry.item);
    if (typeof symbol !== "number") {
      return;
    }
    const meta = ctx.functions.get(symbol);
    if (!meta) {
      return;
    }
    const exportName =
      entry.alias ?? ctx.symbolTable.getSymbol(entry.symbol).name;
    ctx.mod.addFunctionExport(meta.wasmName, exportName);
  });
};

const compileExpression = (
  exprId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  tailPosition = false,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
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
      return compileCallExpr(expr, ctx, fnCtx, {
        tailPosition,
        expectedResultTypeId,
      });
    case "block":
      return compileBlockExpr(
        expr,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId
      );
    case "if":
      return compileIfExpr(
        expr,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId
      );
    case "match":
      return compileMatchExpr(
        expr,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId
      );
    case "while":
      return compileWhileExpr(expr, ctx, fnCtx);
    case "assign":
      return compileAssignExpr(expr, ctx, fnCtx);
    case "object-literal":
      return compileObjectLiteralExpr(expr, ctx, fnCtx);
    case "field-access":
      return compileFieldAccessExpr(expr, ctx, fnCtx);
    case "tuple":
      return compileTupleExpr(expr, ctx, fnCtx);
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
): CompiledExpression => {
  switch (expr.literalKind) {
    case "i32":
      return {
        expr: ctx.mod.i32.const(Number.parseInt(expr.value, 10)),
        usedReturnCall: false,
      };
    case "i64": {
      const value = BigInt(expr.value);
      const low = Number(value & BigInt(0xffffffff));
      const high = Number((value >> BigInt(32)) & BigInt(0xffffffff));
      return {
        expr: ctx.mod.i64.const(low, high),
        usedReturnCall: false,
      };
    }
    case "f32":
      return {
        expr: ctx.mod.f32.const(Number.parseFloat(expr.value)),
        usedReturnCall: false,
      };
    case "f64":
      return {
        expr: ctx.mod.f64.const(Number.parseFloat(expr.value)),
        usedReturnCall: false,
      };
    case "boolean":
      return {
        expr: ctx.mod.i32.const(expr.value === "true" ? 1 : 0),
        usedReturnCall: false,
      };
    case "void":
      return { expr: ctx.mod.nop(), usedReturnCall: false };
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
): CompiledExpression => {
  const binding = fnCtx.bindings.get(expr.symbol);
  if (!binding) {
    throw new Error(
      `codegen cannot reference symbol ${expr.symbol} in this context`
    );
  }
  return {
    expr: ctx.mod.local.get(binding.index, binding.type),
    usedReturnCall: false,
  };
};

const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const callee = ctx.hir.expressions.get(expr.callee);
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  if (callee.exprKind === "overload-set") {
    const targetSymbol = ctx.typing.callTargets.get(expr.id);
    if (typeof targetSymbol !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    const targetMeta = ctx.functions.get(targetSymbol);
    if (!targetMeta) {
      throw new Error(`codegen cannot call symbol ${targetSymbol}`);
    }
    const args = compileCallArguments(expr, targetMeta, ctx, fnCtx);
    return emitResolvedCall(targetMeta, args, expr.id, ctx, {
      tailPosition,
      expectedResultTypeId,
    });
  }

  if (callee.exprKind !== "identifier") {
    throw new Error("codegen only supports direct identifier calls today");
  }

  const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
  const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
    intrinsic?: boolean;
  };

  if (intrinsicMetadata.intrinsic) {
    const args = expr.args.map(
      (arg) => compileExpression(arg.expr, ctx, fnCtx).expr
    );
    return {
      expr: compileIntrinsicCall(symbolRecord.name, expr, args, ctx),
      usedReturnCall: false,
    };
  }

  const targetMeta = ctx.functions.get(callee.symbol);
  if (!targetMeta) {
    throw new Error(`codegen missing metadata for symbol ${callee.symbol}`);
  }
  const args = compileCallArguments(expr, targetMeta, ctx, fnCtx);
  return emitResolvedCall(targetMeta, args, expr.id, ctx, {
    tailPosition,
    expectedResultTypeId,
  });
};

const emitResolvedCall = (
  meta: FunctionMetadata,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const returnTypeId = getRequiredExprType(callId, ctx);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;

  if (
    tailPosition &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx)
  ) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        args as number[],
        getExprBinaryenType(callId, ctx)
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(
      meta.wasmName,
      args as number[],
      getExprBinaryenType(callId, ctx)
    ),
    usedReturnCall: false,
  };
};

const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const statements: binaryen.ExpressionRef[] = [];
  expr.statements.forEach((stmtId) => {
    statements.push(compileStatement(stmtId, ctx, fnCtx));
  });

  if (typeof expr.value === "number") {
    const { expr: valueExpr, usedReturnCall } = compileExpression(
      expr.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId
    );
    if (statements.length === 0) {
      return { expr: valueExpr, usedReturnCall };
    }

    statements.push(valueExpr);
    return {
      expr: ctx.mod.block(null, statements, getExprBinaryenType(expr.id, ctx)),
      usedReturnCall,
    };
  }

  if (statements.length === 0) {
    return { expr: ctx.mod.nop(), usedReturnCall: false };
  }

  return {
    expr: ctx.mod.block(null, statements, binaryen.none),
    usedReturnCall: false,
  };
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
      return asStatement(ctx, compileExpression(stmt.expr, ctx, fnCtx).expr);
    case "return":
      if (typeof stmt.value === "number") {
        const valueExpr = compileExpression(
          stmt.value,
          ctx,
          fnCtx,
          true,
          fnCtx.returnTypeId
        );
        if (valueExpr.usedReturnCall) {
          return valueExpr.expr;
        }
        const actualType = getRequiredExprType(stmt.value, ctx);
        const coerced = coerceValueToType(
          valueExpr.expr,
          actualType,
          fnCtx.returnTypeId,
          ctx,
          fnCtx
        );
        return ctx.mod.return(coerced);
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
  fnCtx: FunctionContext,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const resultType = getExprBinaryenType(expr.id, ctx);
  let fallback =
    typeof expr.defaultBranch === "number"
      ? compileExpression(
          expr.defaultBranch,
          ctx,
          fnCtx,
          tailPosition,
          expectedResultTypeId
        )
      : undefined;

  if (!fallback && resultType !== binaryen.none) {
    throw new Error("non-void if expressions require an else branch");
  }

  if (!fallback) {
    fallback = { expr: ctx.mod.nop(), usedReturnCall: false };
  }

  for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
    const branch = expr.branches[index]!;
    const condition = compileExpression(branch.condition, ctx, fnCtx).expr;
    const value = compileExpression(
      branch.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId
    );
    fallback = {
      expr: ctx.mod.if(condition, value.expr, fallback.expr),
      usedReturnCall: value.usedReturnCall && fallback.usedReturnCall,
    };
  }

  return fallback;
};

const compileMatchExpr = (
  expr: HirMatchExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const discriminantTypeId = getRequiredExprType(expr.discriminant, ctx);
  const discriminantType = wasmTypeFor(discriminantTypeId, ctx);
  const discriminantTemp = allocateTempLocal(discriminantType, fnCtx);
  const discriminantValue = compileExpression(
    expr.discriminant,
    ctx,
    fnCtx
  ).expr;

  const initDiscriminant = ctx.mod.local.set(
    discriminantTemp.index,
    discriminantValue
  );

  let chain: CompiledExpression | undefined;
  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index]!;
    const armValue = compileExpression(
      arm.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId
    );

    if (arm.pattern.kind === "wildcard") {
      chain = armValue;
      continue;
    }

    if (arm.pattern.kind !== "type") {
      throw new Error(`unsupported match pattern ${arm.pattern.kind}`);
    }

    const condition = compileMatchCondition(
      arm.pattern,
      discriminantTemp,
      discriminantTypeId,
      ctx
    );
    const fallback =
      chain ??
      ({
        expr: ctx.mod.unreachable(),
        usedReturnCall: false,
      } as CompiledExpression);

    chain = {
      expr: ctx.mod.if(condition, armValue.expr, fallback.expr),
      usedReturnCall: armValue.usedReturnCall && fallback.usedReturnCall,
    };
  }

  const finalExpr = chain ?? {
    expr: ctx.mod.unreachable(),
    usedReturnCall: false,
  };

  return {
    expr: ctx.mod.block(
      null,
      [initDiscriminant, finalExpr.expr],
      getExprBinaryenType(expr.id, ctx)
    ),
    usedReturnCall: finalExpr.usedReturnCall,
  };
};

const compileMatchCondition = (
  pattern: HirPattern & { kind: "type" },
  discriminant: LocalBinding,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const patternTypeId = resolvePatternTypeForMatch(
    pattern.type,
    discriminantTypeId,
    ctx
  );
  const structInfo = getStructuralTypeInfo(patternTypeId, ctx);
  if (!structInfo) {
    throw new Error("match pattern requires a structural type");
  }

  const pointer = ctx.mod.local.get(discriminant.index, discriminant.type);
  const ancestors = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.extensionHelpers.i32Array,
    fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
    exprRef: pointer,
  });

  return ctx.mod.call(
    "__extends",
    [ctx.mod.i32.const(structInfo.typeId), ancestors],
    binaryen.i32
  );
};

const compileWhileExpr = (
  expr: HirWhileExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(compileExpression(expr.condition, ctx, fnCtx).expr),
    ctx.mod.br(breakLabel)
  );

  const body = asStatement(ctx, compileExpression(expr.body, ctx, fnCtx).expr);
  const loopBody = ctx.mod.block(null, [
    conditionCheck,
    body,
    ctx.mod.br(loopLabel),
  ]);

  return {
    expr: ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};

const compileAssignExpr = (
  expr: HirAssignExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  if (expr.pattern) {
    const ops: binaryen.ExpressionRef[] = [];
    compilePatternInitialization(expr.pattern, expr.value, ctx, fnCtx, ops, {
      declare: false,
    });
    const opExpr =
      ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryen.none);
    return { expr: opExpr, usedReturnCall: false };
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetExpr = ctx.hir.expressions.get(expr.target);
  if (!targetExpr || targetExpr.exprKind !== "identifier") {
    throw new Error("only identifier assignments are supported today");
  }

  const binding = getRequiredBinding(targetExpr.symbol, ctx, fnCtx);
  const targetTypeId = getSymbolTypeId(targetExpr.symbol, ctx);
  const valueTypeId = getRequiredExprType(expr.value, ctx);
  const valueExpr = compileExpression(expr.value, ctx, fnCtx);
  return {
    expr: ctx.mod.local.set(
      binding.index,
      coerceValueToType(valueExpr.expr, valueTypeId, targetTypeId, ctx, fnCtx)
    ),
    usedReturnCall: false,
  };
};

const compileObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const typeId = getRequiredExprType(expr.id, ctx);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("object literal missing structural type information");
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, LocalBinding>();
  const initialized = new Set<string>();

  structInfo.fields.forEach((field) => {
    fieldTemps.set(field.name, allocateTempLocal(field.wasmType, fnCtx));
  });

  expr.entries.forEach((entry) => {
    if (entry.kind === "field") {
      const binding = fieldTemps.get(entry.name);
      if (!binding) {
        throw new Error(
          `object literal cannot set unknown field ${entry.name}`
        );
      }
      ops.push(
        ctx.mod.local.set(
          binding.index,
          compileExpression(entry.value, ctx, fnCtx).expr
        )
      );
      initialized.add(entry.name);
      return;
    }

    const spreadType = getRequiredExprType(entry.value, ctx);
    const spreadInfo = getStructuralTypeInfo(spreadType, ctx);
    if (!spreadInfo) {
      throw new Error("object spread requires a structural object");
    }

    const spreadTemp = allocateTempLocal(spreadInfo.interfaceType, fnCtx);
    ops.push(
      ctx.mod.local.set(
        spreadTemp.index,
        compileExpression(entry.value, ctx, fnCtx).expr
      )
    );

    spreadInfo.fields.forEach((sourceField) => {
      const target = fieldTemps.get(sourceField.name);
      if (!target) {
        return;
      }
      const pointer = ctx.mod.local.get(
        spreadTemp.index,
        spreadInfo.interfaceType
      );
      const lookupTable = structGetFieldValue({
        mod: ctx.mod,
        fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
        fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
        exprRef: pointer,
      });
      const accessor = ctx.mod.call(
        LOOKUP_FIELD_ACCESSOR,
        [
          ctx.mod.i32.const(sourceField.hash),
          lookupTable,
          ctx.mod.i32.const(0),
        ],
        binaryen.funcref
      );
      const getter = refCast(ctx.mod, accessor, sourceField.getterType!);
      const load = callRef(ctx.mod, getter, [pointer], sourceField.wasmType);
      ops.push(ctx.mod.local.set(target.index, load));
      initialized.add(sourceField.name);
    });
  });

  structInfo.fields.forEach((field) => {
    if (!initialized.has(field.name)) {
      throw new Error(`missing initializer for field ${field.name}`);
    }
  });

  const values = [
    ctx.mod.global.get(
      structInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      structInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      structInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...structInfo.fields.map((field) => {
      const binding = fieldTemps.get(field.name);
      if (!binding) {
        throw new Error(`missing binding for field ${field.name}`);
      }
      return ctx.mod.local.get(binding.index, binding.type);
    }),
  ];
  const literal = initStruct(ctx.mod, structInfo.runtimeType, values);
  if (ops.length === 0) {
    return { expr: literal, usedReturnCall: false };
  }
  ops.push(literal);
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx)),
    usedReturnCall: false,
  };
};

const compileTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const typeId = getRequiredExprType(expr.id, ctx);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("tuple missing structural type information");
  }

  if (structInfo.fields.length !== expr.elements.length) {
    throw new Error("tuple arity does not match inferred structural type");
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, LocalBinding>();

  expr.elements.forEach((elementId, index) => {
    const fieldName = `${index}`;
    const field = structInfo.fieldMap.get(fieldName);
    if (!field) {
      throw new Error(`tuple element ${index} missing corresponding field`);
    }
    const temp = allocateTempLocal(field.wasmType, fnCtx);
    fieldTemps.set(field.name, temp);
    ops.push(
      ctx.mod.local.set(
        temp.index,
        compileExpression(elementId, ctx, fnCtx).expr
      )
    );
  });

  const values = [
    ctx.mod.global.get(
      structInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      structInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      structInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...structInfo.fields.map((field) => {
      const temp = fieldTemps.get(field.name);
      if (!temp) {
        throw new Error(`missing binding for tuple field ${field.name}`);
      }
      return ctx.mod.local.get(temp.index, temp.type);
    }),
  ];

  const tupleValue = initStruct(ctx.mod, structInfo.runtimeType, values);
  if (ops.length === 0) {
    return { expr: tupleValue, usedReturnCall: false };
  }
  ops.push(tupleValue);
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx)),
    usedReturnCall: false,
  };
};

const loadStructuralField = (
  structInfo: StructuralTypeInfo,
  field: StructuralFieldInfo,
  pointer: binaryen.ExpressionRef,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(0)],
    binaryen.funcref
  );
  const getter = refCast(ctx.mod, accessor, field.getterType!);
  return callRef(ctx.mod, getter, [pointer], field.wasmType);
};

const compileFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const targetType = getRequiredExprType(expr.target, ctx);
  const structInfo = getStructuralTypeInfo(targetType, ctx);
  if (!structInfo) {
    throw new Error("field access requires a structural object");
  }

  const field = structInfo.fieldMap.get(expr.field);
  if (!field) {
    throw new Error(`object does not contain field ${expr.field}`);
  }

  const pointerTemp = allocateTempLocal(structInfo.interfaceType, fnCtx);
  const storePointer = ctx.mod.local.set(
    pointerTemp.index,
    compileExpression(expr.target, ctx, fnCtx).expr
  );
  const pointer = ctx.mod.local.get(
    pointerTemp.index,
    structInfo.interfaceType
  );
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(0)],
    binaryen.funcref
  );
  const getter = refCast(ctx.mod, accessor, field.getterType!);
  const value = callRef(ctx.mod, getter, [pointer], field.wasmType);
  return {
    expr: ctx.mod.block(null, [storePointer, value], field.wasmType),
    usedReturnCall: false,
  };
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
    ops.push(asStatement(ctx, compileExpression(initializer, ctx, fnCtx).expr));
    return;
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  const binding = options.declare
    ? declareLocal(pattern.symbol, ctx, fnCtx)
    : getRequiredBinding(pattern.symbol, ctx, fnCtx);
  const targetTypeId = getSymbolTypeId(pattern.symbol, ctx);
  const initializerType = getRequiredExprType(initializer, ctx);
  const value = compileExpression(initializer, ctx, fnCtx);

  ops.push(
    ctx.mod.local.set(
      binding.index,
      coerceValueToType(value.expr, initializerType, targetTypeId, ctx, fnCtx)
    )
  );
};

interface PendingTupleAssignment {
  pattern: Extract<HirPattern, { kind: "identifier" }>;
  tempIndex: number;
  tempType: binaryen.Type;
  typeId: TypeId;
}

const compileTuplePattern = (
  pattern: HirPattern & { kind: "tuple" },
  initializer: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  ops: binaryen.ExpressionRef[],
  options: PatternInitOptions
): void => {
  const initializerType = getRequiredExprType(initializer, ctx);
  const initializerTemp = allocateTempLocal(
    wasmTypeFor(initializerType, ctx),
    fnCtx
  );
  ops.push(
    ctx.mod.local.set(
      initializerTemp.index,
      compileExpression(initializer, ctx, fnCtx).expr
    )
  );

  const pending = collectTupleAssignmentsFromValue(
    pattern,
    initializerTemp,
    initializerType,
    ctx,
    fnCtx,
    ops
  );
  pending.forEach(({ pattern: subPattern, tempIndex, tempType, typeId }) => {
    const binding = options.declare
      ? declareLocal(subPattern.symbol, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    const targetTypeId = getSymbolTypeId(subPattern.symbol, ctx);
    ops.push(
      ctx.mod.local.set(
        binding.index,
        coerceValueToType(
          ctx.mod.local.get(tempIndex, tempType),
          typeId,
          targetTypeId,
          ctx,
          fnCtx
        )
      )
    );
  });
};

const collectTupleAssignmentsFromValue = (
  pattern: HirPattern,
  temp: LocalBinding,
  typeId: TypeId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  ops: binaryen.ExpressionRef[]
): PendingTupleAssignment[] => {
  if (pattern.kind === "tuple") {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("tuple pattern requires a structural tuple value");
    }
    if (pattern.elements.length !== structInfo.fields.length) {
      throw new Error("tuple pattern arity mismatch");
    }
    const pointer = ctx.mod.local.get(temp.index, temp.type);
    const collected: PendingTupleAssignment[] = [];
    pattern.elements.forEach((subPattern, index) => {
      const field = structInfo.fieldMap.get(`${index}`);
      if (!field) {
        throw new Error(`tuple is missing element ${index}`);
      }
      const elementTemp = allocateTempLocal(field.wasmType, fnCtx);
      const load = loadStructuralField(structInfo, field, pointer, ctx);
      ops.push(ctx.mod.local.set(elementTemp.index, load));
      collected.push(
        ...collectTupleAssignmentsFromValue(
          subPattern,
          elementTemp,
          field.typeId,
          ctx,
          fnCtx,
          ops
        )
      );
    });
    return collected;
  }

  if (pattern.kind === "wildcard") {
    return [];
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported tuple sub-pattern ${pattern.kind}`);
  }

  return [
    {
      pattern,
      tempIndex: temp.index,
      tempType: temp.type,
      typeId,
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
    case "==":
    case "!=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx
      );
      return emitEqualityIntrinsic(name, operandKind, args, ctx);
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

const emitEqualityIntrinsic = (
  op: "==" | "!=",
  kind: NumericKind,
  args: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      return op === "=="
        ? ctx.mod.i32.eq(left, right)
        : ctx.mod.i32.ne(left, right);
    case "i64":
      return op === "=="
        ? ctx.mod.i64.eq(left, right)
        : ctx.mod.i64.ne(left, right);
    case "f32":
      return op === "=="
        ? ctx.mod.f32.eq(left, right)
        : ctx.mod.f32.ne(left, right);
    case "f64":
      return op === "=="
        ? ctx.mod.f64.eq(left, right)
        : ctx.mod.f64.ne(left, right);
  }
  throw new Error(`unsupported ${op} equality for numeric kind ${kind}`);
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

const requiresStructuralConversion = (
  actualType: TypeId,
  targetType: TypeId | undefined,
  ctx: CodegenContext
): boolean => {
  if (typeof targetType !== "number" || actualType === targetType) {
    return false;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return false;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    return false;
  }

  return actualInfo.typeId !== targetInfo.typeId;
};

const coerceValueToType = (
  value: binaryen.ExpressionRef,
  actualType: TypeId,
  targetType: TypeId | undefined,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (typeof targetType !== "number" || actualType === targetType) {
    return value;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return value;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    throw new Error("cannot coerce non-structural value to structural type");
  }

  if (actualInfo.typeId === targetInfo.typeId) {
    return value;
  }

  return emitStructuralConversion(value, actualInfo, targetInfo, ctx, fnCtx);
};

const emitStructuralConversion = (
  value: binaryen.ExpressionRef,
  actual: StructuralTypeInfo,
  target: StructuralTypeInfo,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  target.fields.forEach((field) => {
    if (!actual.fieldMap.has(field.name)) {
      throw new Error(
        `structural value missing field ${field.name} required for conversion`
      );
    }
  });

  const temp = allocateTempLocal(actual.interfaceType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(temp.index, value)];
  const sourceRef = ctx.mod.local.get(temp.index, actual.interfaceType);

  const fieldValues = target.fields.map((field) => {
    const sourceField = actual.fieldMap.get(field.name)!;
    const lookupTable = structGetFieldValue({
      mod: ctx.mod,
      fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
      fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
      exprRef: sourceRef,
    });
    const accessor = ctx.mod.call(
      LOOKUP_FIELD_ACCESSOR,
      [ctx.mod.i32.const(sourceField.hash), lookupTable, ctx.mod.i32.const(0)],
      binaryen.funcref
    );
    const getter = refCast(ctx.mod, accessor, sourceField.getterType!);
    return callRef(ctx.mod, getter, [sourceRef], sourceField.wasmType);
  });

  const converted = initStruct(ctx.mod, target.runtimeType, [
    ctx.mod.global.get(
      target.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      target.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      target.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...fieldValues,
  ]);
  ops.push(converted);
  return ctx.mod.block(null, ops, target.interfaceType);
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

const getTypeIdFromTypeExpr = (
  expr: HirTypeExpr,
  ctx: CodegenContext
): TypeId => {
  if (typeof expr.typeId === "number") {
    return expr.typeId;
  }
  throw new Error("codegen expected type-annotated HIR type expression");
};

const resolvePatternTypeForMatch = (
  type: HirTypeExpr,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): TypeId => {
  const resolved = getTypeIdFromTypeExpr(type, ctx);
  const narrowed = narrowPatternType(resolved, discriminantTypeId, ctx);
  return typeof narrowed === "number" ? narrowed : resolved;
};

const narrowPatternType = (
  patternTypeId: TypeId,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const patternNominal = getNominalComponentId(patternTypeId, ctx);
  if (typeof patternNominal !== "number") {
    return undefined;
  }

  const discriminantDesc = ctx.typing.arena.get(discriminantTypeId);
  if (discriminantDesc.kind === "union") {
    const matches = discriminantDesc.members.filter((member) =>
      nominalOwnersMatch(patternNominal, member, ctx)
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    return undefined;
  }

  return nominalOwnersMatch(patternNominal, discriminantTypeId, ctx)
    ? discriminantTypeId
    : undefined;
};

const nominalOwnersMatch = (
  patternNominal: TypeId,
  candidateType: TypeId,
  ctx: CodegenContext
): boolean => {
  const candidateNominal = getNominalComponentId(candidateType, ctx);
  if (typeof candidateNominal !== "number") {
    return false;
  }
  return (
    getNominalOwner(candidateNominal, ctx) ===
    getNominalOwner(patternNominal, ctx)
  );
};

const getNominalComponentId = (
  typeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

const getNominalOwner = (nominalId: TypeId, ctx: CodegenContext): SymbolId => {
  const desc = ctx.typing.arena.get(nominalId);
  if (desc.kind !== "nominal-object") {
    throw new Error("expected nominal type");
  }
  return desc.owner;
};

const wasmTypeFor = (typeId: TypeId, ctx: CodegenContext): binaryen.Type => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "primitive") {
    return mapPrimitiveToWasm(desc.name);
  }

  if (desc.kind === "structural-object") {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("missing structural type info");
    }
    return structInfo.interfaceType;
  }

  if (desc.kind === "union") {
    if (desc.members.length === 0) {
      throw new Error("cannot map empty union to wasm");
    }
    const memberTypes = desc.members.map((member) => wasmTypeFor(member, ctx));
    const first = memberTypes[0]!;
    if (!memberTypes.every((candidate) => candidate === first)) {
      throw new Error("union members map to different wasm types");
    }
    return first;
  }

  if (desc.kind === "intersection" && typeof desc.structural === "number") {
    return wasmTypeFor(desc.structural, ctx);
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

const getStructuralTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext
): StructuralTypeInfo | undefined => {
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId !== "number") {
    return undefined;
  }

  const cached = ctx.structTypes.get(structuralId);
  if (cached) {
    return cached;
  }

  const desc = ctx.typing.arena.get(structuralId);
  if (desc.kind !== "structural-object") {
    return undefined;
  }

  const fields: StructuralFieldInfo[] = desc.fields.map((field, index) => ({
    name: field.name,
    typeId: field.type,
    wasmType: wasmTypeFor(field.type, ctx),
    runtimeIndex: index + RTT_METADATA_SLOT_COUNT,
    hash: 0,
  }));
  const typeLabel = `struct_${structuralId}`;
  const runtimeType = defineStructType(ctx.mod, {
    name: typeLabel,
    fields: [
      {
        name: "__ancestors_table",
        type: ctx.rtt.extensionHelpers.i32Array,
        mutable: false,
      },
      {
        name: "__field_index_table",
        type: ctx.rtt.fieldLookupHelpers.lookupTableType,
        mutable: false,
      },
      {
        name: "__method_lookup_table",
        type: ctx.rtt.methodLookupHelpers.lookupTableType,
        mutable: false,
      },
      ...fields.map((field) => ({
        name: field.name,
        type: field.wasmType,
        mutable: true,
      })),
    ],
    supertype: binaryenTypeToHeapType(ctx.rtt.baseType),
    final: true,
  });
  const fieldTableExpr = ctx.rtt.fieldLookupHelpers.registerType({
    typeLabel,
    runtimeType,
    baseType: ctx.rtt.baseType,
    fields,
  });
  const methodTableExpr = ctx.rtt.methodLookupHelpers.createTable([]);

  const ancestorsGlobal = `__ancestors_table_${typeLabel}`;
  ctx.mod.addGlobal(
    ancestorsGlobal,
    ctx.rtt.extensionHelpers.i32Array,
    false,
    ctx.rtt.extensionHelpers.initExtensionArray([structuralId])
  );

  const fieldTableGlobal = `__field_index_table_${typeLabel}`;
  ctx.mod.addGlobal(
    fieldTableGlobal,
    ctx.rtt.fieldLookupHelpers.lookupTableType,
    false,
    fieldTableExpr
  );

  const methodTableGlobal = `__method_table_${typeLabel}`;
  ctx.mod.addGlobal(
    methodTableGlobal,
    ctx.rtt.methodLookupHelpers.lookupTableType,
    false,
    methodTableExpr
  );

  const info: StructuralTypeInfo = {
    typeId: structuralId,
    runtimeType,
    interfaceType: ctx.rtt.baseType,
    fields,
    fieldMap: new Map(fields.map((field) => [field.name, field])),
    ancestorsGlobal,
    fieldTableGlobal,
    methodTableGlobal,
    typeLabel,
  };
  ctx.structTypes.set(structuralId, info);
  return info;
};

const resolveStructuralTypeId = (
  typeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "structural-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.structural === "number") {
    return desc.structural;
  }
  return undefined;
};
const compileCallArguments = (
  call: HirCallExpr,
  meta: FunctionMetadata,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef[] => {
  return call.args.map((arg, index) => {
    const expectedTypeId = meta.paramTypeIds[index];
    const actualTypeId = getRequiredExprType(arg.expr, ctx);
    const value = compileExpression(arg.expr, ctx, fnCtx);
    return coerceValueToType(
      value.expr,
      actualTypeId,
      expectedTypeId,
      ctx,
      fnCtx
    );
  });
};
