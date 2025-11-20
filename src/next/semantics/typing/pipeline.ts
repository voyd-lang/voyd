import type { SymbolTable } from "../binder/index.js";
import type {
  HirAssignExpr,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFieldAccessExpr,
  HirFunction,
  HirGraph,
  HirIfExpr,
  HirLetStatement,
  HirLiteralExpr,
  HirMatchExpr,
  HirObjectLiteralEntry,
  HirObjectLiteralExpr,
  HirObjectDecl,
  HirObjectTypeExpr,
  HirOverloadSetExpr,
  HirPattern,
  HirTypeExpr,
  HirNamedTypeExpr,
  HirTupleTypeExpr,
  HirUnionTypeExpr,
  HirWhileExpr,
} from "../hir/index.js";
import type {
  EffectRowId,
  HirExprId,
  HirStmtId,
  OverloadSetId,
  SymbolId,
  TypeId,
} from "../ids.js";
import { DeclTable, type FunctionDecl, type ParameterDecl } from "../decls.js";
import { createTypeArena, type TypeArena } from "./type-arena.js";
import { createTypeTable, type TypeTable } from "./type-table.js";

interface TypingInputs {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  decls?: DeclTable;
}

export interface TypingResult {
  arena: TypeArena;
  table: TypeTable;
  valueTypes: ReadonlyMap<SymbolId, TypeId>;
  callTargets: ReadonlyMap<HirExprId, SymbolId>;
}

interface FunctionSignature {
  typeId: TypeId;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
  hasExplicitReturn: boolean;
}

interface ParamSignature {
  type: TypeId;
  label?: string;
}

interface Arg {
  type: TypeId;
  label?: string;
}

type TypeCheckMode = "relaxed" | "strict";

interface TypingContext {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  decls: DeclTable;
  arena: TypeArena;
  table: TypeTable;
  functionSignatures: Map<SymbolId, FunctionSignature>;
  valueTypes: Map<SymbolId, TypeId>;
  callTargets: Map<HirExprId, SymbolId>;
  primitiveCache: Map<string, TypeId>;
  intrinsicTypes: Map<string, TypeId>;
  objects: Map<SymbolId, ObjectTypeInfo>;
  objectsByName: Map<string, SymbolId>;
  objectsByNominal: Map<TypeId, ObjectTypeInfo>;
  objectDecls: Map<SymbolId, HirObjectDecl>;
  resolvingObjects: Set<SymbolId>;
  boolType: TypeId;
  voidType: TypeId;
  unknownType: TypeId;
  defaultEffectRow: EffectRowId;
  typeCheckMode: TypeCheckMode;
  currentFunctionReturnType: TypeId | undefined;
  typeAliasTargets: Map<SymbolId, HirTypeExpr>;
  typeAliasTypes: Map<SymbolId, TypeId>;
  typeAliasesByName: Map<string, SymbolId>;
  resolvingTypeAliases: Set<SymbolId>;
  baseObjectSymbol: SymbolId;
  baseObjectNominal: TypeId;
  baseObjectStructural: TypeId;
  baseObjectType: TypeId;
}

interface ObjectTypeInfo {
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly { name: string; type: TypeId }[];
  baseNominal?: TypeId;
}

const DEFAULT_EFFECT_ROW: EffectRowId = 0;
const BASE_OBJECT_NAME = "Object";

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const decls = inputs.decls ?? new DeclTable();
  const arena = createTypeArena();
  const table = createTypeTable();

  const ctx: TypingContext = {
    symbolTable: inputs.symbolTable,
    hir: inputs.hir,
    overloads: inputs.overloads,
    decls,
    arena,
    table,
    functionSignatures: new Map(),
    valueTypes: new Map(),
    callTargets: new Map(),
    primitiveCache: new Map(),
    intrinsicTypes: new Map(),
    objects: new Map(),
    objectsByName: new Map(),
    objectsByNominal: new Map(),
    objectDecls: new Map(),
    resolvingObjects: new Set(),
    boolType: 0,
    voidType: 0,
    unknownType: 0,
    defaultEffectRow: DEFAULT_EFFECT_ROW,
    typeCheckMode: "relaxed",
    currentFunctionReturnType: undefined,
    typeAliasTargets: new Map(),
    typeAliasTypes: new Map(),
    typeAliasesByName: new Map(),
    resolvingTypeAliases: new Set(),
    baseObjectSymbol: -1,
    baseObjectNominal: -1,
    baseObjectStructural: -1,
    baseObjectType: -1,
  };

  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  registerTypeAliases(ctx);
  registerObjectDecls(ctx);
  registerFunctionSignatures(ctx);

  runInferencePass(ctx);
  runStrictTypeCheck(ctx);

  return {
    arena,
    table,
    valueTypes: new Map(ctx.valueTypes),
    callTargets: new Map(ctx.callTargets),
  };
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

const seedBaseObjectType = (ctx: TypingContext): void => {
  const symbol = ctx.symbolTable.declare({
    name: BASE_OBJECT_NAME,
    kind: "type",
    declaredAt: ctx.hir.module.ast,
    metadata: { intrinsic: true, entity: "object" },
  });

  const structural = ctx.arena.internStructuralObject({ fields: [] });
  const nominal = ctx.arena.internNominalObject({
    owner: symbol,
    name: BASE_OBJECT_NAME,
    typeArgs: [],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  const info: ObjectTypeInfo = {
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  };

  ctx.baseObjectSymbol = symbol;
  ctx.baseObjectNominal = nominal;
  ctx.baseObjectStructural = structural;
  ctx.baseObjectType = type;

  ctx.objects.set(symbol, info);
  ctx.objectsByNominal.set(nominal, info);
  if (!ctx.objectsByName.has(BASE_OBJECT_NAME)) {
    ctx.objectsByName.set(BASE_OBJECT_NAME, symbol);
  }
  ctx.valueTypes.set(symbol, type);
};

const registerTypeAliases = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "type-alias") continue;
    const decl =
      (typeof item.decl === "number"
        ? ctx.decls.getTypeAliasById(item.decl)
        : ctx.decls.getTypeAlias(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!decl || decl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for type alias symbol ${item.symbol}`
      );
    }
    ctx.typeAliasTargets.set(item.symbol, item.target);
    ctx.typeAliasesByName.set(getSymbolName(item.symbol, ctx), item.symbol);
  }
};

const registerObjectDecls = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "object") continue;
    ctx.objectDecls.set(item.symbol, item);
    const name = getSymbolName(item.symbol, ctx);
    if (!ctx.objectsByName.has(name)) {
      ctx.objectsByName.set(name, item.symbol);
    }
  }
};

const registerFunctionSignatures = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const fnDecl =
      (typeof item.decl === "number"
        ? ctx.decls.getFunctionById(item.decl)
        : ctx.decls.getFunction(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!fnDecl || fnDecl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for function symbol ${item.symbol}`
      );
    }

    if (fnDecl && fnDecl.params.length !== item.parameters.length) {
      throw new Error(
        `function parameter count mismatch for symbol ${item.symbol}: decl defines ${fnDecl.params.length}, HIR has ${item.parameters.length}`
      );
    }

    const parameters = item.parameters.map((param, index) => {
      const resolved = resolveTypeExpr(param.type, ctx, ctx.unknownType);
      ctx.valueTypes.set(param.symbol, resolved);
      const declParam =
        (typeof param.decl === "number"
          ? ctx.decls.getParameterById(param.decl)
          : undefined) ?? ctx.decls.getParameter(param.symbol);
      if (
        typeof param.decl === "number" &&
        (!declParam || declParam.symbol !== param.symbol)
      ) {
        throw new Error(
          `missing or mismatched parameter decl for symbol ${
            param.symbol
          } in function ${getSymbolName(item.symbol, ctx)}`
        );
      }
      if (
        fnDecl?.params[index] &&
        fnDecl.params[index]!.symbol !== param.symbol
      ) {
        throw new Error(
          `parameter order mismatch for function ${getSymbolName(
            item.symbol,
            ctx
          )}`
        );
      }
      return { type: resolved, label: declParam?.label ?? param.label };
    });

    const hasExplicitReturn = Boolean(item.returnType);
    const declaredReturn =
      resolveTypeExpr(item.returnType, ctx, ctx.unknownType) ?? ctx.unknownType;

    const functionType = ctx.arena.internFunction({
      parameters: parameters.map(({ type, label }) => ({
        type,
        label,
        optional: false,
      })),
      returnType: declaredReturn,
      effects: ctx.defaultEffectRow,
    });

    ctx.functionSignatures.set(item.symbol, {
      typeId: functionType,
      parameters,
      returnType: declaredReturn,
      hasExplicitReturn,
    });
    ctx.valueTypes.set(item.symbol, functionType);

    const scheme = ctx.arena.newScheme([], functionType);
    ctx.table.setSymbolScheme(item.symbol, scheme);
  }
};

const runInferencePass = (ctx: TypingContext): void => {
  ctx.typeCheckMode = "relaxed";
  let changed: boolean;
  do {
    ctx.table.clearExprTypes();
    changed = typeAllFunctions(ctx, { collectChanges: true });
  } while (changed);

  const unresolved = Array.from(ctx.functionSignatures.entries()).filter(
    ([, signature]) => !signature.hasExplicitReturn
  );
  if (unresolved.length > 0) {
    const names = unresolved.map(([symbol]) => getSymbolName(symbol, ctx));
    throw new Error(
      `could not infer return type for function(s): ${names.join(", ")}`
    );
  }
};

const runStrictTypeCheck = (ctx: TypingContext): void => {
  ctx.typeCheckMode = "strict";
  ctx.table.clearExprTypes();
  typeAllFunctions(ctx, { collectChanges: false });
};

const typeAllFunctions = (
  ctx: TypingContext,
  options: { collectChanges: boolean }
): boolean => {
  let changed = false;
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const updated = typeFunction(item, ctx);
    if (options.collectChanges) {
      changed = updated || changed;
    }
  }
  return options.collectChanges ? changed : false;
};

const typeFunction = (fn: HirFunction, ctx: TypingContext): boolean => {
  const signature = ctx.functionSignatures.get(fn.symbol);
  if (!signature) {
    throw new Error(`missing type signature for function symbol ${fn.symbol}`);
  }

  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = signature.returnType;
  let bodyType: TypeId;
  try {
    bodyType = typeExpression(fn.body, ctx);
  } finally {
    ctx.currentFunctionReturnType = previousReturnType;
  }
  if (signature.hasExplicitReturn) {
    ensureTypeMatches(
      bodyType,
      signature.returnType,
      ctx,
      `function ${getSymbolName(fn.symbol, ctx)} return type`
    );
    return false;
  }

  if (bodyType === ctx.unknownType) {
    return false;
  }

  finalizeFunctionReturnType(fn, signature, bodyType, ctx);
  return true;
};

const finalizeFunctionReturnType = (
  fn: HirFunction,
  signature: FunctionSignature,
  inferred: TypeId,
  ctx: TypingContext
): void => {
  signature.returnType = inferred;
  const functionType = ctx.arena.internFunction({
    parameters: signature.parameters.map(({ type, label }) => ({
      type,
      label,
      optional: false,
    })),
    returnType: inferred,
    effects: ctx.defaultEffectRow,
  });
  signature.typeId = functionType;
  ctx.valueTypes.set(fn.symbol, functionType);
  const scheme = ctx.arena.newScheme([], functionType);
  ctx.table.setSymbolScheme(fn.symbol, scheme);
  signature.hasExplicitReturn = true;
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
    case "overload-set":
      type = typeOverloadSetExpr(expr, ctx);
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
    case "match":
      type = typeMatchExpr(expr, ctx);
      break;
    case "tuple":
      type = typeTupleExpr(expr, ctx);
      break;
    case "object-literal":
      type = typeObjectLiteralExpr(expr, ctx);
      break;
    case "field-access":
      type = typeFieldAccessExpr(expr, ctx);
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

const typeOverloadSetExpr = (
  expr: HirExpression & {
    exprKind: "overload-set";
    name: string;
    set: OverloadSetId;
  },
  ctx: TypingContext
): TypeId => {
  throw new Error(
    `overload set ${expr.name} cannot be used outside of a call expression`
  );
};

const typeCallExpr = (expr: HirCallExpr, ctx: TypingContext): TypeId => {
  if (expr.typeArguments && expr.typeArguments.length > 0) {
    throw new Error("polymorphic calls are not supported yet");
  }

  const args = expr.args.map((arg) => ({
    label: arg.label,
    type: typeExpression(arg.expr, ctx),
  }));
  const calleeExpr = ctx.hir.expressions.get(expr.callee);
  if (!calleeExpr) {
    throw new Error(`missing callee expression ${expr.callee}`);
  }

  if (calleeExpr.exprKind === "overload-set") {
    ctx.table.setExprType(calleeExpr.id, ctx.unknownType);
    return typeOverloadedCall(expr, calleeExpr, args, ctx);
  }

  const calleeType = typeExpression(expr.callee, ctx);

  if (calleeExpr.exprKind === "identifier") {
    const record = ctx.symbolTable.getSymbol(calleeExpr.symbol);
    const metadata = (record.metadata ?? {}) as { intrinsic?: boolean };
    if (metadata.intrinsic) {
      return typeIntrinsicCall(record.name, args, ctx);
    }
  }

  const calleeDesc = ctx.arena.get(calleeType);
  if (calleeDesc.kind !== "function") {
    throw new Error("attempted to call a non-function value");
  }

  if (args.length !== calleeDesc.parameters.length) {
    throw new Error("call argument count mismatch");
  }

  args.forEach((arg, index) => {
    const param = calleeDesc.parameters[index];
    if (param.label !== arg.label) {
      const expectedLabel = param.label ?? "no label";
      const actualLabel = arg.label ?? "no label";
      throw new Error(
        `call argument ${
          index + 1
        } label mismatch: expected ${expectedLabel}, got ${actualLabel}`
      );
    }
    ensureTypeMatches(arg.type, param.type, ctx, `call argument ${index + 1}`);
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
      if (typeof ctx.currentFunctionReturnType !== "number") {
        throw new Error("return statement outside of function");
      }

      const expectedReturnType = ctx.currentFunctionReturnType;
      if (typeof stmt.value === "number") {
        const valueType = typeExpression(stmt.value, ctx);
        ensureTypeMatches(
          valueType,
          expectedReturnType,
          ctx,
          "return statement"
        );
        return;
      }

      ensureTypeMatches(
        ctx.voidType,
        expectedReturnType,
        ctx,
        "return statement"
      );
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
  const hasDefault = typeof expr.defaultBranch === "number";
  let branchType: TypeId | undefined;

  expr.branches.forEach((branch, index) => {
    const conditionType = typeExpression(branch.condition, ctx);
    ensureTypeMatches(
      conditionType,
      ctx.boolType,
      ctx,
      `if condition ${index + 1}`
    );

    const valueType = typeExpression(branch.value, ctx);
    branchType = mergeBranchType(branchType, valueType);
  });

  if (hasDefault) {
    const defaultType = typeExpression(expr.defaultBranch!, ctx);
    branchType = mergeBranchType(branchType, defaultType);
    return branchType ?? ctx.voidType;
  }

  return ctx.voidType;
};

const typeMatchExpr = (expr: HirMatchExpr, ctx: TypingContext): TypeId => {
  const discriminantType = typeExpression(expr.discriminant, ctx);
  const discriminantExpr = ctx.hir.expressions.get(expr.discriminant);
  const discriminantSymbol =
    discriminantExpr?.exprKind === "identifier"
      ? discriminantExpr.symbol
      : undefined;

  const discriminantDesc = ctx.arena.get(discriminantType);
  const unionMembers =
    discriminantDesc.kind === "union"
      ? [...discriminantDesc.members]
      : undefined;
  const remainingMembers = unionMembers ? new Set(unionMembers) : undefined;

  let branchType: TypeId | undefined;

  expr.arms.forEach((arm, index) => {
    const narrowed = narrowMatchPattern(
      discriminantType,
      arm.pattern,
      ctx,
      `match arm ${index + 1}`
    );
    const valueType = withNarrowedDiscriminant(
      discriminantSymbol,
      narrowed,
      ctx,
      () => typeExpression(arm.value, ctx)
    );
    branchType = mergeBranchType(branchType, valueType);

    if (!remainingMembers) {
      return;
    }

    if (arm.pattern.kind === "wildcard") {
      remainingMembers.clear();
      return;
    }

    if (arm.pattern.kind === "type") {
      const patternType = resolveTypeExpr(
        arm.pattern.type,
        ctx,
        ctx.unknownType
      );
      matchedUnionMembers(patternType, remainingMembers, ctx).forEach(
        (member) => remainingMembers.delete(member)
      );
    }
  });

  if (remainingMembers && remainingMembers.size > 0) {
    throw new Error("non-exhaustive match");
  }

  return branchType ?? ctx.voidType;
};

const typeTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: TypingContext
): TypeId => {
  const fields = expr.elements.map((elementId, index) => ({
    name: `${index}`,
    type: typeExpression(elementId, ctx),
  }));
  return ctx.arena.internStructuralObject({ fields });
};

const typeObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext
): TypeId => {
  if (expr.literalKind === "nominal") {
    return typeNominalObjectLiteral(expr, ctx);
  }

  const fields = new Map<string, TypeId>();
  expr.entries.forEach((entry) => mergeObjectLiteralEntry(entry, fields, ctx));

  const orderedFields = Array.from(fields.entries()).map(([name, type]) => ({
    name,
    type,
  }));
  return ctx.arena.internStructuralObject({ fields: orderedFields });
};

const mergeObjectLiteralEntry = (
  entry: HirObjectLiteralEntry,
  fields: Map<string, TypeId>,
  ctx: TypingContext
): void => {
  if (entry.kind === "field") {
    const valueType = typeExpression(entry.value, ctx);
    fields.set(entry.name, valueType);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx);
  if (spreadType === ctx.unknownType) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx);
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }
  spreadFields.forEach((field) => fields.set(field.name, field.type));
};

const typeNominalObjectLiteral = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext
): TypeId => {
  const targetSymbol =
    expr.targetSymbol ??
    (expr.target?.typeKind === "named"
      ? ctx.objectsByName.get(expr.target.path[0]!)
      : undefined);
  if (typeof targetSymbol !== "number") {
    throw new Error("nominal object literal missing target type");
  }

  const objectInfo = ensureObjectType(targetSymbol, ctx);
  if (!objectInfo) {
    throw new Error("missing object type information for nominal literal");
  }

  const declaredFields = new Map<string, TypeId>(
    objectInfo.fields.map((field) => [field.name, field.type])
  );
  const provided = new Map<string, TypeId>();

  expr.entries.forEach((entry) =>
    mergeNominalObjectEntry(entry, declaredFields, provided, ctx)
  );

  declaredFields.forEach((_, name) => {
    if (!provided.has(name)) {
      throw new Error(`missing initializer for field ${name}`);
    }
  });

  return objectInfo.type;
};

const mergeNominalObjectEntry = (
  entry: HirObjectLiteralEntry,
  declared: Map<string, TypeId>,
  provided: Map<string, TypeId>,
  ctx: TypingContext
): void => {
  if (entry.kind === "field") {
    const expectedType = declared.get(entry.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${entry.name}`);
    }
    const valueType = typeExpression(entry.value, ctx);
    ensureTypeMatches(valueType, expectedType, ctx, `field ${entry.name}`);
    provided.set(entry.name, expectedType);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx);
  if (spreadType === ctx.unknownType) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx);
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }

  spreadFields.forEach((field) => {
    const expectedType = declared.get(field.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${field.name}`);
    }
    ensureTypeMatches(
      field.type,
      expectedType,
      ctx,
      `spread field ${field.name}`
    );
    provided.set(field.name, expectedType);
  });
};

const typeFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: TypingContext
): TypeId => {
  const targetType = typeExpression(expr.target, ctx);
  if (targetType === ctx.unknownType) {
    return ctx.unknownType;
  }

  const fields = getStructuralFields(targetType, ctx);
  if (!fields) {
    throw new Error("field access requires an object type");
  }

  const field = fields.find((candidate) => candidate.name === expr.field);
  if (!field) {
    if (ctx.typeCheckMode === "relaxed") {
      return ctx.unknownType;
    }
    throw new Error(`object type is missing field ${expr.field}`);
  }

  return field.type;
};

const typeWhileExpr = (expr: HirWhileExpr, ctx: TypingContext): TypeId => {
  const conditionType = typeExpression(expr.condition, ctx);
  ensureTypeMatches(conditionType, ctx.boolType, ctx, "while condition");
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
  ensureTypeMatches(valueType, targetType, ctx, "assignment target");
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

const typeOverloadedCall = (
  call: HirCallExpr,
  callee: HirOverloadSetExpr,
  argTypes: readonly Arg[],
  ctx: TypingContext
): TypeId => {
  const options = ctx.overloads.get(callee.set);
  if (!options) {
    throw new Error(
      `missing overload metadata for ${callee.name} (set ${callee.set})`
    );
  }

  const matches = options
    .map((symbol) => {
      const signature = ctx.functionSignatures.get(symbol);
      if (!signature) {
        throw new Error(
          `missing type signature for overloaded function ${getSymbolName(
            symbol,
            ctx
          )}`
        );
      }
      return { symbol, signature };
    })
    .filter(({ symbol, signature }) =>
      matchesOverloadSignature(symbol, signature, argTypes, ctx)
    );

  if (matches.length === 0) {
    throw new Error(`no overload of ${callee.name} matches argument types`);
  }

  if (matches.length > 1) {
    throw new Error(`ambiguous overload for ${callee.name}`);
  }

  const selected = matches[0]!;
  ctx.callTargets.set(call.id, selected.symbol);
  return selected.signature.returnType;
};

const matchesOverloadSignature = (
  symbol: SymbolId,
  signature: FunctionSignature,
  args: readonly Arg[],
  ctx: TypingContext
): boolean => {
  if (signature.parameters.length !== args.length) {
    return false;
  }

  signature.parameters.forEach(({ type }) => {
    if (type === ctx.unknownType) {
      throw new Error(
        `overloaded function ${getSymbolName(
          symbol,
          ctx
        )} must declare parameter types`
      );
    }
  });

  return signature.parameters.every((param, index) => {
    const arg = args[index];
    if (arg.label !== param.label) {
      return false;
    }

    if (arg.type === ctx.unknownType) {
      return true;
    }

    return typeSatisfies(arg.type, param.type, ctx);
  });
};

const typeIntrinsicCall = (
  name: string,
  args: readonly Arg[],
  ctx: TypingContext
): TypeId => {
  const signatures = intrinsicSignaturesFor(name, ctx);
  if (signatures.length === 0) {
    throw new Error(`unsupported intrinsic ${name}`);
  }

  const matches = signatures.filter((signature) =>
    intrinsicSignatureMatches(signature, args, ctx)
  );

  if (matches.length === 0) {
    throw new Error(`no matching overload for intrinsic ${name}`);
  }

  if (matches.length > 1) {
    throw new Error(`ambiguous intrinsic overload for ${name}`);
  }

  return matches[0]!.returnType;
};

const intrinsicSignatureMatches = (
  signature: IntrinsicSignature,
  args: readonly Arg[],
  ctx: TypingContext
): boolean => {
  if (signature.parameters.length !== args.length) {
    return false;
  }
  return signature.parameters.every((param, index) => {
    const arg = args[index];
    return arg.type === ctx.unknownType || param === arg.type;
  });
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

  const signatures = intrinsicSignaturesFor(name, ctx);
  if (signatures.length === 0) {
    throw new Error(`unsupported intrinsic ${name}`);
  }

  const signature = signatures[0]!;
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

const intrinsicSignaturesFor = (
  name: string,
  ctx: TypingContext
): readonly IntrinsicSignature[] => {
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  const float32 = getPrimitiveType(ctx, "f32");
  const float64 = getPrimitiveType(ctx, "f64");

  const numericSignatures: IntrinsicSignature[] = [
    { parameters: [int32, int32], returnType: int32 },
    { parameters: [int64, int64], returnType: int64 },
    { parameters: [float32, float32], returnType: float32 },
    { parameters: [float64, float64], returnType: float64 },
  ];
  const comparisonSignatures: IntrinsicSignature[] = [
    { parameters: [int32, int32], returnType: ctx.boolType },
    { parameters: [int64, int64], returnType: ctx.boolType },
    { parameters: [float32, float32], returnType: ctx.boolType },
    { parameters: [float64, float64], returnType: ctx.boolType },
  ];

  switch (name) {
    case "+":
    case "-":
    case "*":
    case "/":
      return numericSignatures;
    case "<":
    case "<=":
    case ">":
    case ">=":
    case "==":
    case "!=":
      return comparisonSignatures;
    default:
      return [];
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
    case "object":
      return resolveObjectTypeExpr(expr, ctx);
    case "tuple":
      return resolveTupleTypeExpr(expr, ctx);
    case "union":
      return resolveUnionTypeExpr(expr, ctx);
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
  if (name === BASE_OBJECT_NAME) {
    return ctx.baseObjectType;
  }
  const aliasSymbol = ctx.typeAliasesByName.get(name);
  if (aliasSymbol !== undefined) {
    return resolveTypeAlias(aliasSymbol, ctx);
  }

  const objectSymbol = ctx.objectsByName.get(name);
  if (objectSymbol !== undefined) {
    const info = ensureObjectType(objectSymbol, ctx);
    return info?.type ?? ctx.unknownType;
  }

  const resolved = ctx.primitiveCache.get(name);
  if (typeof resolved === "number") {
    return resolved;
  }

  return getPrimitiveType(ctx, name);
};

const resolveObjectTypeExpr = (
  expr: HirObjectTypeExpr,
  ctx: TypingContext
): TypeId => {
  const fields = expr.fields.map((field) => ({
    name: field.name,
    type: resolveTypeExpr(field.type, ctx, ctx.unknownType),
  }));
  return ctx.arena.internStructuralObject({ fields });
};

const resolveTupleTypeExpr = (
  expr: HirTupleTypeExpr,
  ctx: TypingContext
): TypeId => {
  const fields = expr.elements.map((element, index) => ({
    name: `${index}`,
    type: resolveTypeExpr(element, ctx, ctx.unknownType),
  }));
  return ctx.arena.internStructuralObject({ fields });
};

const resolveUnionTypeExpr = (
  expr: HirUnionTypeExpr,
  ctx: TypingContext
): TypeId => {
  const members = expr.members.map((member) =>
    resolveTypeExpr(member, ctx, ctx.unknownType)
  );
  return ctx.arena.internUnion(members);
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
  const initializerType = typeExpression(exprId, ctx);
  const initializerExpr = ctx.hir.expressions.get(exprId);

  if (initializerExpr?.exprKind === "tuple") {
    if (initializerExpr.elements.length !== pattern.elements.length) {
      throw new Error("tuple pattern length mismatch");
    }

    pattern.elements.forEach((subPattern, index) => {
      const elementExprId = initializerExpr.elements[index]!;
      if (subPattern.kind === "tuple") {
        bindTuplePatternFromExpr(subPattern, elementExprId, ctx, mode);
        return;
      }
      const cached = ctx.table.getExprType(elementExprId);
      const elementType =
        typeof cached === "number"
          ? cached
          : typeExpression(elementExprId, ctx);
      recordPatternType(subPattern, elementType, ctx, mode);
    });
    return;
  }

  bindTuplePatternFromType(pattern, initializerType, ctx, mode);
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
        ctx,
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

const bindTuplePatternFromType = (
  pattern: HirPattern & { kind: "tuple" },
  type: TypeId,
  ctx: TypingContext,
  mode: PatternBindingMode
): void => {
  const fields = getStructuralFields(type, ctx);
  if (!fields) {
    throw new Error("tuple pattern requires a tuple initializer");
  }

  const fieldByIndex = new Map<string, TypeId>(
    fields.map((field) => [field.name, field.type])
  );

  if (fieldByIndex.size !== pattern.elements.length) {
    throw new Error("tuple pattern length mismatch");
  }

  pattern.elements.forEach((subPattern, index) => {
    const fieldType = fieldByIndex.get(`${index}`);
    if (typeof fieldType !== "number") {
      throw new Error(`tuple is missing element ${index}`);
    }
    if (subPattern.kind === "tuple") {
      bindTuplePatternFromType(subPattern, fieldType, ctx, mode);
      return;
    }
    recordPatternType(subPattern, fieldType, ctx, mode);
  });
};

const narrowMatchPattern = (
  discriminantType: TypeId,
  pattern: HirPattern,
  ctx: TypingContext,
  reason: string
): TypeId => {
  switch (pattern.kind) {
    case "wildcard":
      return discriminantType;
    case "type": {
      const patternType = resolveTypeExpr(pattern.type, ctx, ctx.unknownType);
      const narrowed = narrowTypeForPattern(discriminantType, patternType, ctx);
      if (typeof narrowed !== "number") {
        throw new Error(`pattern does not match discriminant for ${reason}`);
      }
      return narrowed;
    }
    default:
      throw new Error(`unsupported match pattern ${pattern.kind}`);
  }
};

const withNarrowedDiscriminant = (
  symbol: SymbolId | undefined,
  narrowedType: TypeId,
  ctx: TypingContext,
  run: () => TypeId
): TypeId => {
  if (typeof symbol !== "number" || narrowedType === ctx.unknownType) {
    return run();
  }

  const previous = ctx.valueTypes.get(symbol);
  ctx.valueTypes.set(symbol, narrowedType);
  try {
    return run();
  } finally {
    if (typeof previous === "number") {
      ctx.valueTypes.set(symbol, previous);
    } else {
      ctx.valueTypes.delete(symbol);
    }
  }
};

const matchedUnionMembers = (
  patternType: TypeId,
  remaining: Set<TypeId>,
  ctx: TypingContext
): TypeId[] => {
  if (patternType === ctx.unknownType) {
    return [];
  }
  return Array.from(remaining).filter((member) =>
    typeSatisfies(member, patternType, ctx)
  );
};

const narrowTypeForPattern = (
  discriminantType: TypeId,
  patternType: TypeId,
  ctx: TypingContext
): TypeId | undefined => {
  if (discriminantType === ctx.unknownType) {
    return patternType;
  }
  const desc = ctx.arena.get(discriminantType);
  if (desc.kind === "union") {
    const matches = desc.members.filter((member) =>
      typeSatisfies(member, patternType, ctx)
    );
    if (matches.length === 0) {
      return undefined;
    }
    return matches.length === 1 ? matches[0] : ctx.arena.internUnion(matches);
  }
  return typeSatisfies(discriminantType, patternType, ctx)
    ? discriminantType
    : undefined;
};

const ensureTypeMatches = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  reason: string
): void => {
  if (typeSatisfies(actual, expected, ctx)) {
    return;
  }

  throw new Error(`type mismatch for ${reason}`);
};

const typeSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext
): boolean => {
  if (actual === expected) {
    return true;
  }

  if (
    ctx.typeCheckMode === "relaxed" &&
    (actual === ctx.unknownType || expected === ctx.unknownType)
  ) {
    return true;
  }

  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind === "union") {
    return actualDesc.members.every((member) =>
      typeSatisfies(member, expected, ctx)
    );
  }

  const expectedDesc = ctx.arena.get(expected);
  if (expectedDesc.kind === "union") {
    return expectedDesc.members.some((member) =>
      typeSatisfies(actual, member, ctx)
    );
  }

  const expectedNominal = getNominalComponent(expected, ctx);
  if (expectedNominal) {
    const actualNominal = getNominalComponent(actual, ctx);
    if (actualNominal && nominalExtends(actualNominal, expectedNominal, ctx)) {
      return true;
    }
    if (
      expectedNominal === ctx.baseObjectNominal &&
      structuralTypeSatisfies(actual, expected, ctx)
    ) {
      return true;
    }
    return false;
  }

  return structuralTypeSatisfies(actual, expected, ctx);
};

const resolveTypeAlias = (symbol: SymbolId, ctx: TypingContext): TypeId => {
  const cached = ctx.typeAliasTypes.get(symbol);
  if (typeof cached === "number") {
    return cached;
  }

  if (ctx.resolvingTypeAliases.has(symbol)) {
    return ctx.unknownType;
  }

  const target = ctx.typeAliasTargets.get(symbol);
  if (!target) {
    throw new Error(
      `missing type alias target for ${getSymbolName(symbol, ctx)}`
    );
  }

  ctx.resolvingTypeAliases.add(symbol);
  try {
    const resolved = resolveTypeExpr(target, ctx, ctx.unknownType);
    ctx.typeAliasTypes.set(symbol, resolved);
    return resolved;
  } finally {
    ctx.resolvingTypeAliases.delete(symbol);
  }
};

const getSymbolName = (symbol: SymbolId, ctx: TypingContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;

const ensureObjectType = (
  symbol: SymbolId,
  ctx: TypingContext
): ObjectTypeInfo | undefined => {
  const cached = ctx.objects.get(symbol);
  if (cached) {
    return cached;
  }

  if (ctx.resolvingObjects.has(symbol)) {
    return undefined;
  }

  const decl = ctx.objectDecls.get(symbol);
  if (!decl) {
    return undefined;
  }

  ctx.resolvingObjects.add(symbol);
  try {
    const baseType = resolveTypeExpr(decl.base, ctx, ctx.baseObjectType);
    const baseFields = getStructuralFields(baseType, ctx) ?? [];
    const baseNominal = getNominalComponent(baseType, ctx);

    const ownFields = decl.fields.map((field) => ({
      name: field.name,
      type: resolveTypeExpr(field.type, ctx, ctx.unknownType),
    }));

    const fields = mergeDeclaredFields(baseFields, ownFields);
    const structural = ctx.arena.internStructuralObject({ fields });
    const nominal = ctx.arena.internNominalObject({
      owner: symbol,
      name: getSymbolName(symbol, ctx),
      typeArgs: [],
    });
    const type = ctx.arena.internIntersection({
      nominal,
      structural,
    });
    const info: ObjectTypeInfo = {
      nominal,
      structural,
      type,
      fields,
      baseNominal,
    };

    ctx.objects.set(symbol, info);
    ctx.objectsByNominal.set(nominal, info);
    ctx.valueTypes.set(symbol, type);
    return info;
  } finally {
    ctx.resolvingObjects.delete(symbol);
  }
};

const mergeDeclaredFields = (
  inherited: readonly { name: string; type: TypeId }[],
  own: readonly { name: string; type: TypeId }[]
): { name: string; type: TypeId }[] => {
  const fields = new Map<string, TypeId>();
  inherited.forEach((field) => fields.set(field.name, field.type));
  own.forEach((field) => fields.set(field.name, field.type));
  return Array.from(fields.entries()).map(([name, type]) => ({ name, type }));
};

const getObjectInfoForNominal = (
  nominal: TypeId,
  ctx: TypingContext
): ObjectTypeInfo | undefined => {
  const cached = ctx.objectsByNominal.get(nominal);
  if (cached) {
    return cached;
  }
  const desc = ctx.arena.get(nominal);
  if (desc.kind !== "nominal-object") {
    return undefined;
  }
  return ensureObjectType(desc.owner, ctx);
};

const getNominalComponent = (
  type: TypeId,
  ctx: TypingContext
): TypeId | undefined => {
  if (type === ctx.unknownType) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "nominal-object":
      return type;
    case "intersection":
      if (typeof desc.nominal === "number") {
        return desc.nominal;
      }
      if (typeof desc.structural === "number") {
        return getNominalComponent(desc.structural, ctx);
      }
      return undefined;
    default:
      return undefined;
  }
};

const nominalExtends = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext
): boolean => {
  if (actual === expected) {
    return true;
  }
  const info = getObjectInfoForNominal(actual, ctx);
  if (info?.baseNominal) {
    return nominalExtends(info.baseNominal, expected, ctx);
  }
  return false;
};

const getStructuralFields = (
  type: TypeId,
  ctx: TypingContext
): readonly { name: string; type: TypeId }[] | undefined => {
  if (type === ctx.unknownType) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  if (desc.kind === "structural-object") {
    return desc.fields;
  }

  if (desc.kind === "nominal-object") {
    const info = ensureObjectType(desc.owner, ctx);
    if (info) {
      return getStructuralFields(info.structural, ctx);
    }
    return undefined;
  }

  if (desc.kind === "intersection") {
    const info =
      typeof desc.nominal === "number"
        ? getObjectInfoForNominal(desc.nominal, ctx)
        : undefined;
    if (info) {
      return getStructuralFields(info.structural, ctx);
    }
    if (typeof desc.structural === "number") {
      return getStructuralFields(desc.structural, ctx);
    }
  }

  return undefined;
};

// Performs a best-effort structural compatibility check so callers can assign
// objects that share the same field layout even if their type IDs differ.
const structuralTypeSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  seen: Set<string> = new Set()
): boolean => {
  if (actual === expected) {
    return true;
  }

  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind === "union") {
    return actualDesc.members.every((member) =>
      structuralTypeSatisfies(member, expected, ctx, seen)
    );
  }

  const expectedDesc = ctx.arena.get(expected);
  if (expectedDesc.kind === "union") {
    return expectedDesc.members.some((member) =>
      structuralTypeSatisfies(actual, member, ctx, seen)
    );
  }

  const expectedFields = getStructuralFields(expected, ctx);
  if (!expectedFields) {
    return false;
  }

  const actualFields = getStructuralFields(actual, ctx);
  if (!actualFields) {
    return false;
  }

  if (expectedFields.length === 0) {
    return actualFields.length >= 0;
  }

  const cacheKey = `${actual}->${expected}`;
  if (seen.has(cacheKey)) {
    return true;
  }
  seen.add(cacheKey);

  return expectedFields.every((expectedField) => {
    const candidate = actualFields.find(
      (field) => field.name === expectedField.name
    );
    if (!candidate) {
      return false;
    }

    if (candidate.type === expectedField.type) {
      return true;
    }

    if (
      ctx.typeCheckMode === "relaxed" &&
      (candidate.type === ctx.unknownType ||
        expectedField.type === ctx.unknownType)
    ) {
      return true;
    }

    return structuralTypeSatisfies(
      candidate.type,
      expectedField.type,
      ctx,
      seen
    );
  });
};
