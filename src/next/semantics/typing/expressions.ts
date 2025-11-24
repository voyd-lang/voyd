import type {
  HirAssignExpr,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirFieldAccessExpr,
  HirIfExpr,
  HirLetStatement,
  HirLiteralExpr,
  HirMatchExpr,
  HirObjectLiteralEntry,
  HirObjectLiteralExpr,
  HirPattern,
  HirTypeExpr,
  HirWhileExpr,
  HirOverloadSetExpr,
} from "../hir/index.js";
import type {
  HirExprId,
  HirStmtId,
  OverloadSetId,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../ids.js";
import {
  bindTypeParamsFromType,
  ensureTypeMatches,
  getNominalComponent,
  getObjectTemplate,
  getPrimitiveType,
  getStructuralFields,
  ensureObjectType,
  matchedUnionMembers,
  narrowTypeForPattern,
  resolveTypeExpr,
  typeSatisfies,
  getSymbolName,
} from "./type-system.js";
import type {
  Arg,
  FunctionSignature,
  FunctionTypeParam,
  ParamSignature,
  TypingState,
  TypingContext,
} from "./types.js";

const applyCurrentSubstitution = (
  type: TypeId,
  ctx: TypingContext,
  state: TypingState
): TypeId =>
  state.currentFunction?.substitution
    ? ctx.arena.substitute(type, state.currentFunction.substitution)
    : type;

export const typeExpression = (
  exprId: HirExprId,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const cached = ctx.table.getExprType(exprId);
  if (typeof cached === "number") {
    const applied = applyCurrentSubstitution(cached, ctx, state);
    ctx.resolvedExprTypes.set(exprId, applied);
    return applied;
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
      type = typeCallExpr(expr, ctx, state);
      break;
    case "block":
      type = typeBlockExpr(expr, ctx, state);
      break;
    case "if":
      type = typeIfExpr(expr, ctx, state);
      break;
    case "match":
      type = typeMatchExpr(expr, ctx, state);
      break;
    case "tuple":
      type = typeTupleExpr(expr, ctx, state);
      break;
    case "object-literal":
      type = typeObjectLiteralExpr(expr, ctx, state);
      break;
    case "field-access":
      type = typeFieldAccessExpr(expr, ctx, state);
      break;
    case "while":
      type = typeWhileExpr(expr, ctx, state);
      break;
    case "assign":
      type = typeAssignExpr(expr, ctx, state);
      break;
    default:
      throw new Error(`unsupported expression kind: ${expr.exprKind}`);
  }

  const appliedType = applyCurrentSubstitution(type, ctx, state);
  ctx.table.setExprType(exprId, type);
  ctx.resolvedExprTypes.set(exprId, appliedType);
  return appliedType;
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
      return ctx.primitives.bool;
    case "void":
      return ctx.primitives.void;
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

const typeCallExpr = (
  expr: HirCallExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const args = expr.args.map((arg) => ({
    label: arg.label,
    type: typeExpression(arg.expr, ctx, state),
  }));
  const calleeExpr = ctx.hir.expressions.get(expr.callee);
  if (!calleeExpr) {
    throw new Error(`missing callee expression ${expr.callee}`);
  }

  if (calleeExpr.exprKind === "overload-set") {
    if (expr.typeArguments && expr.typeArguments.length > 0) {
      throw new Error(
        "type arguments are not supported with overload sets yet"
      );
    }
    ctx.table.setExprType(calleeExpr.id, ctx.primitives.unknown);
    return typeOverloadedCall(expr, calleeExpr, args, ctx, state);
  }

  if (calleeExpr.exprKind === "identifier") {
    const record = ctx.symbolTable.getSymbol(calleeExpr.symbol);
    const metadata = (record.metadata ?? {}) as { intrinsic?: boolean };
    if (metadata.intrinsic) {
      return typeIntrinsicCall(record.name, args, ctx);
    }

    const signature = ctx.functions.getSignature(calleeExpr.symbol);
    if (signature) {
      const typeArguments = resolveTypeArguments(expr.typeArguments, ctx, state);
      return typeFunctionCall({
        args,
        signature,
        calleeSymbol: calleeExpr.symbol,
        typeArguments,
        callId: expr.id,
        ctx,
        state,
      });
    }
  }

  const calleeType = typeExpression(expr.callee, ctx, state);

  if (expr.typeArguments && expr.typeArguments.length > 0) {
    throw new Error("call does not accept type arguments");
  }

  const calleeDesc = ctx.arena.get(calleeType);
  if (calleeDesc.kind !== "function") {
    throw new Error("attempted to call a non-function value");
  }

  validateCallArgs(args, calleeDesc.parameters, ctx, state);

  return calleeDesc.returnType;
};

const resolveTypeArguments = (
  typeArguments: readonly HirTypeExpr[] | undefined,
  ctx: TypingContext,
  state: TypingState
): TypeId[] | undefined =>
  typeArguments && typeArguments.length > 0
    ? typeArguments.map((entry) =>
        resolveTypeExpr(
          entry,
          ctx,
          state,
          ctx.primitives.unknown,
          state.currentFunction?.typeParams
        )
      )
    : undefined;

const validateCallArgs = (
  args: readonly Arg[],
  params: readonly ParamSignature[],
  ctx: TypingContext,
  state: TypingState
): void => {
  if (args.length !== params.length) {
    throw new Error("call argument count mismatch");
  }

  args.forEach((arg, index) => {
    const param = params[index]!;
    if (param.label !== arg.label) {
      const expectedLabel = param.label ?? "no label";
      const actualLabel = arg.label ?? "no label";
      throw new Error(
        `call argument ${
        index + 1
      } label mismatch: expected ${expectedLabel}, got ${actualLabel}`
      );
    }
    ensureTypeMatches(
      arg.type,
      param.type,
      ctx,
      state,
      `call argument ${index + 1}`
    );
  });
};

const typeFunctionCall = ({
  args,
  signature,
  calleeSymbol,
  typeArguments,
  callId,
  ctx,
  state,
}: {
  args: readonly Arg[];
  signature: FunctionSignature;
  calleeSymbol: SymbolId;
  typeArguments?: readonly TypeId[];
  callId: HirExprId;
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  const hasTypeParams = signature.typeParams && signature.typeParams.length > 0;
  const instantiation = hasTypeParams
    ? instantiateFunctionCall({
        signature,
        args,
        typeArguments,
        calleeSymbol,
        ctx,
        state,
      })
    : {
        substitution: new Map<TypeParamId, TypeId>(),
        parameters: signature.parameters,
        returnType: signature.returnType,
      };

  if (!hasTypeParams && typeArguments && typeArguments.length > 0) {
    throw new Error("call does not accept type arguments");
  }

  validateCallArgs(args, instantiation.parameters, ctx, state);

  if (hasTypeParams) {
    const mergedSubstitution = mergeSubstitutions(
      instantiation.substitution,
      state.currentFunction?.substitution,
      ctx
    );
  const appliedTypeArgs = getAppliedTypeArguments({
    signature,
    substitution: mergedSubstitution,
    symbol: calleeSymbol,
    ctx,
  });
    const callKey = formatFunctionInstanceKey(calleeSymbol, appliedTypeArgs);
    ctx.callResolution.typeArguments.set(callId, appliedTypeArgs);
    ctx.callResolution.instanceKeys.set(callId, callKey);
    typeGenericFunctionBody({
      symbol: calleeSymbol,
      signature,
      substitution: instantiation.substitution,
      ctx,
      state,
    });
  } else {
    ctx.callResolution.typeArguments.delete(callId);
  }

  return instantiation.returnType;
};

const instantiateFunctionCall = ({
  signature,
  args,
  typeArguments,
  calleeSymbol,
  ctx,
  state,
}: {
  signature: FunctionSignature;
  args: readonly Arg[];
  typeArguments?: readonly TypeId[];
  calleeSymbol: SymbolId;
  ctx: TypingContext;
  state: TypingState;
}): {
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
} => {
  const typeParams = signature.typeParams ?? [];

  if (typeArguments && typeArguments.length > typeParams.length) {
    throw new Error(
      `function ${getSymbolName(
        calleeSymbol,
        ctx
      )} received too many type arguments`
    );
  }

  const substitution = new Map<TypeParamId, TypeId>();
  typeParams.forEach((param, index) => {
    const explicit = typeArguments?.[index];
    if (typeof explicit === "number") {
      substitution.set(param.typeParam, explicit);
    }
  });

  args.forEach((arg, index) => {
    const expected = signature.parameters[index];
    if (!expected) {
      return;
    }
    const expectedType = ctx.arena.substitute(expected.type, substitution);
    bindTypeParamsFromType(expectedType, arg.type, substitution, ctx, state);
  });

  const missing = typeParams.filter(
    (param) => !substitution.has(param.typeParam)
  );
  if (missing.length > 0) {
    throw new Error(
      `function ${getSymbolName(
        calleeSymbol,
        ctx
      )} is missing ${missing.length} type argument(s)`
    );
  }

  typeParams.forEach((param) =>
    enforceTypeParamConstraint(param, substitution, ctx, state)
  );

  const parameters = signature.parameters.map((param) => ({
    ...param,
    type: ctx.arena.substitute(param.type, substitution),
  }));
  const returnType = ctx.arena.substitute(signature.returnType, substitution);

  return { substitution, parameters, returnType };
};

const enforceTypeParamConstraint = (
  param: FunctionTypeParam,
  substitution: ReadonlyMap<TypeParamId, TypeId>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (!param.constraint) {
    return;
  }
  const applied = substitution.get(param.typeParam);
  if (typeof applied !== "number") {
    return;
  }
  const constraint = ctx.arena.substitute(param.constraint, substitution);
  if (!typeSatisfies(applied, constraint, ctx, state)) {
    throw new Error(
      `type argument for ${getSymbolName(
        param.symbol,
        ctx
      )} does not satisfy its constraint`
    );
  }
};

const typeGenericFunctionBody = ({
  symbol,
  signature,
  substitution,
  ctx,
  state,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): void => {
  const typeParams = signature.typeParams ?? [];
  if (typeParams.length === 0) {
    return;
  }

  const previousFunction = state.currentFunction;

  const mergedSubstitution = mergeSubstitutions(
    substitution,
    previousFunction?.substitution,
    ctx
  );
  const appliedTypeArgs = getAppliedTypeArguments({
    signature,
    substitution: mergedSubstitution,
    symbol,
    ctx,
  });
  const key = formatFunctionInstanceKey(symbol, appliedTypeArgs);
  if (ctx.functions.isCachedOrActive(key)) {
    return;
  }

  const fn = ctx.functions.getFunction(symbol);
  if (!fn) {
    throw new Error(`missing function body for symbol ${symbol}`);
  }

  ctx.functions.beginInstantiation(key);
  ctx.table.pushExprTypeScope();
  const previousResolved = ctx.resolvedExprTypes;
  ctx.resolvedExprTypes = new Map();
  const nextTypeParams =
    signature.typeParamMap && previousFunction?.typeParams
      ? new Map([
          ...previousFunction.typeParams.entries(),
          ...signature.typeParamMap.entries(),
        ])
      : signature.typeParamMap ?? previousFunction?.typeParams;
  const expectedReturn = ctx.arena.substitute(
    signature.returnType,
    mergedSubstitution
  );

  state.currentFunction = {
    returnType: expectedReturn,
    instanceKey: key,
    typeParams: nextTypeParams,
    substitution: mergedSubstitution,
  };

  let bodyType: TypeId | undefined;

  try {
    bodyType = typeExpression(fn.body, ctx, state);
    ensureTypeMatches(
      bodyType,
      expectedReturn,
      ctx,
      state,
      `function ${getSymbolName(symbol, ctx)} return type`
    );
    ctx.functions.cacheInstance(key, expectedReturn, ctx.resolvedExprTypes);
    ctx.functions.recordInstantiation(symbol, key, appliedTypeArgs);
  } finally {
    state.currentFunction = previousFunction;
    ctx.resolvedExprTypes = previousResolved;
    ctx.table.popExprTypeScope();
    ctx.functions.endInstantiation(key);
  }
};

const mergeSubstitutions = (
  current: ReadonlyMap<TypeParamId, TypeId>,
  previous: ReadonlyMap<TypeParamId, TypeId> | undefined,
  ctx: TypingContext
): ReadonlyMap<TypeParamId, TypeId> => {
  if (!previous || previous.size === 0) {
    return current;
  }

  const merged = new Map(previous);
  current.forEach((value, key) => {
    merged.set(key, ctx.arena.substitute(value, merged));
  });
  return merged;
};

const recordFunctionInstantiation = ({
  symbol,
  key,
  typeArgs,
  ctx,
}: {
  symbol: SymbolId;
  key: string;
  typeArgs: readonly TypeId[];
  ctx: TypingContext;
}): void => {
  ctx.functions.recordInstantiation(symbol, key, typeArgs);
};

const getAppliedTypeArguments = ({
  signature,
  substitution,
  symbol,
  ctx,
}: {
  signature: FunctionSignature;
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  symbol: SymbolId;
  ctx: TypingContext;
}): readonly TypeId[] => {
  const typeParams = signature.typeParams ?? [];
  return typeParams.map((param) => {
    const applied = substitution.get(param.typeParam);
    if (typeof applied !== "number") {
      throw new Error(
      `function ${getSymbolName(
        symbol,
        ctx
      )} is missing a type argument for ${getSymbolName(param.symbol, ctx)}`
    );
  }
    if (applied === ctx.primitives.unknown) {
      throw new Error(
        `function ${getSymbolName(
          symbol,
          ctx
        )} has unresolved type argument for ${getSymbolName(
          param.symbol,
          ctx
        )}`
      );
    }
    return applied;
  });
};

export const formatFunctionInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

const typeBlockExpr = (
  expr: HirBlockExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  expr.statements.forEach((stmtId) => typeStatement(stmtId, ctx, state));
  if (typeof expr.value === "number") {
    return typeExpression(expr.value, ctx, state);
  }
  return ctx.primitives.void;
};

const typeStatement = (
  stmtId: HirStmtId,
  ctx: TypingContext,
  state: TypingState
): void => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      typeExpression(stmt.expr, ctx, state);
      return;
    case "return":
      if (typeof state.currentFunction?.returnType !== "number") {
        throw new Error("return statement outside of function");
      }

      const expectedReturnType = state.currentFunction.returnType;
      if (typeof stmt.value === "number") {
        const valueType = typeExpression(stmt.value, ctx, state);
        ensureTypeMatches(
          valueType,
          expectedReturnType,
          ctx,
          state,
          "return statement"
        );
        return;
      }

      ensureTypeMatches(
        ctx.primitives.void,
        expectedReturnType,
        ctx,
        state,
        "return statement"
      );
      return;
    case "let":
      typeLetStatement(stmt, ctx, state);
      return;
    default: {
      const unreachable: never = stmt;
      throw new Error("unsupported statement kind");
    }
  }
};

const typeLetStatement = (
  stmt: HirLetStatement,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (stmt.pattern.kind === "tuple") {
    bindTuplePatternFromExpr(stmt.pattern, stmt.initializer, ctx, state, "declare");
    return;
  }

  const initializerType = typeExpression(stmt.initializer, ctx, state);
  recordPatternType(stmt.pattern, initializerType, ctx, state, "declare");
};

const typeIfExpr = (
  expr: HirIfExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const hasDefault = typeof expr.defaultBranch === "number";
  let branchType: TypeId | undefined;

  expr.branches.forEach((branch, index) => {
    const conditionType = typeExpression(branch.condition, ctx, state);
    ensureTypeMatches(
      conditionType,
      ctx.primitives.bool,
      ctx,
      state,
      `if condition ${index + 1}`
    );

    const valueType = typeExpression(branch.value, ctx, state);
    branchType = mergeBranchType(branchType, valueType);
  });

  if (hasDefault) {
    const defaultType = typeExpression(expr.defaultBranch!, ctx, state);
    branchType = mergeBranchType(branchType, defaultType);
    return branchType ?? ctx.primitives.void;
  }

  return ctx.primitives.void;
};

const typeMatchExpr = (
  expr: HirMatchExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const discriminantType = typeExpression(expr.discriminant, ctx, state);
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
      state,
      `match arm ${index + 1}`
    );
    const valueType = withNarrowedDiscriminant(
      discriminantSymbol,
      narrowed,
      ctx,
      () => typeExpression(arm.value, ctx, state)
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
        state,
        ctx.primitives.unknown
      );
      matchedUnionMembers(patternType, remainingMembers, ctx, state).forEach(
        (member) => remainingMembers.delete(member)
      );
    }
  });

  if (remainingMembers && remainingMembers.size > 0) {
    throw new Error("non-exhaustive match");
  }

  return branchType ?? ctx.primitives.void;
};

const typeTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const fields = expr.elements.map((elementId, index) => ({
    name: `${index}`,
    type: typeExpression(elementId, ctx, state),
  }));
  return ctx.arena.internStructuralObject({ fields });
};

const typeObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  if (expr.literalKind === "nominal") {
    return typeNominalObjectLiteral(expr, ctx, state);
  }

  const fields = new Map<string, TypeId>();
  expr.entries.forEach((entry) =>
    mergeObjectLiteralEntry(entry, fields, ctx, state)
  );

  const orderedFields = Array.from(fields.entries()).map(([name, type]) => ({
    name,
    type,
  }));
  return ctx.arena.internStructuralObject({ fields: orderedFields });
};

const mergeObjectLiteralEntry = (
  entry: HirObjectLiteralEntry,
  fields: Map<string, TypeId>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (entry.kind === "field") {
    const valueType = typeExpression(entry.value, ctx, state);
    fields.set(entry.name, valueType);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state);
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }
  spreadFields.forEach((field) => fields.set(field.name, field.type));
};

const typeNominalObjectLiteral = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const namedTarget =
    expr.target?.typeKind === "named" ? expr.target : undefined;
  const targetSymbol =
    expr.targetSymbol ??
    namedTarget?.symbol ??
    (namedTarget ? ctx.objects.resolveName(namedTarget.path[0]!) : undefined);
  if (typeof targetSymbol !== "number") {
    throw new Error("nominal object literal missing target type");
  }

  const template = getObjectTemplate(targetSymbol, ctx, state);
  if (!template) {
    throw new Error("missing object template for nominal literal");
  }

  const templateFields = new Map<string, TypeId>(
    template.fields.map((field) => [field.name, field.type])
  );
  const typeParamBindings = new Map<TypeParamId, TypeId>();
  const seenFields = new Set<string>();

  expr.entries.forEach((entry) =>
    bindNominalObjectEntry(
      entry,
      templateFields,
      typeParamBindings,
      seenFields,
      ctx,
      state
    )
  );

  const explicitTypeArgs =
    namedTarget?.typeArguments?.map((arg) =>
      resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown)
    ) ?? [];
  const typeArgs = template.params.map((param, index) => {
    const explicit = explicitTypeArgs[index];
    if (typeof explicit === "number") {
      return explicit;
    }
    const inferred = typeParamBindings.get(param.typeParam);
    return inferred ?? ctx.primitives.unknown;
  });

  const objectInfo = ensureObjectType(targetSymbol, ctx, state, typeArgs);
  if (!objectInfo) {
    throw new Error("missing object type information for nominal literal");
  }

  const declaredFields = new Map<string, TypeId>(
    objectInfo.fields.map((field) => [field.name, field.type])
  );
  const provided = new Set<string>();

  expr.entries.forEach((entry) =>
    mergeNominalObjectEntry(
      entry,
      declaredFields,
      provided,
      ctx,
      state
    )
  );

  declaredFields.forEach((_, name) => {
    if (!provided.has(name)) {
      throw new Error(`missing initializer for field ${name}`);
    }
  });

  return objectInfo.type;
};

const bindNominalObjectEntry = (
  entry: HirObjectLiteralEntry,
  declared: Map<string, TypeId>,
  bindings: Map<TypeParamId, TypeId>,
  provided: Set<string>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (entry.kind === "field") {
    const expectedType = declared.get(entry.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${entry.name}`);
    }
    bindTypeParamsFromType(
      expectedType,
      typeExpression(entry.value, ctx, state),
      bindings,
      ctx,
      state
    );
    provided.add(entry.name);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state);
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }

  spreadFields.forEach((field) => {
    const expectedType = declared.get(field.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${field.name}`);
    }
    bindTypeParamsFromType(expectedType, field.type, bindings, ctx, state);
    provided.add(field.name);
  });
};

const mergeNominalObjectEntry = (
  entry: HirObjectLiteralEntry,
  declared: Map<string, TypeId>,
  provided: Set<string>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (entry.kind === "field") {
    const expectedType = declared.get(entry.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${entry.name}`);
    }
    const valueType = typeExpression(entry.value, ctx, state);
    if (expectedType !== ctx.primitives.unknown) {
      ensureTypeMatches(valueType, expectedType, ctx, state, `field ${entry.name}`);
    }
    provided.add(entry.name);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state);
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }

  spreadFields.forEach((field) => {
    const expectedType = declared.get(field.name);
    if (!expectedType) {
      throw new Error(`nominal object does not declare field ${field.name}`);
    }
    if (expectedType !== ctx.primitives.unknown) {
      ensureTypeMatches(
        field.type,
        expectedType,
        ctx,
        state,
        `spread field ${field.name}`
      );
    }
    provided.add(field.name);
  });
};

const typeFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const targetType = typeExpression(expr.target, ctx, state);
  if (targetType === ctx.primitives.unknown) {
    return ctx.primitives.unknown;
  }

  const fields = getStructuralFields(targetType, ctx, state);
  if (!fields) {
    throw new Error("field access requires an object type");
  }

  const field = fields.find((candidate) => candidate.name === expr.field);
  if (!field) {
    if (state.mode === "relaxed") {
      return ctx.primitives.unknown;
    }
    throw new Error(`object type is missing field ${expr.field}`);
  }

  return field.type;
};

const typeWhileExpr = (
  expr: HirWhileExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const conditionType = typeExpression(expr.condition, ctx, state);
  ensureTypeMatches(conditionType, ctx.primitives.bool, ctx, state, "while condition");
  typeExpression(expr.body, ctx, state);
  return ctx.primitives.void;
};

const typeAssignExpr = (
  expr: HirAssignExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  if (expr.pattern) {
    typeTupleAssignment(expr.pattern, expr.value, ctx, state);
    return ctx.primitives.void;
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetType = typeExpression(expr.target, ctx, state);
  const valueType = typeExpression(expr.value, ctx, state);
  ensureTypeMatches(valueType, targetType, ctx, state, "assignment target");
  return ctx.primitives.void;
};

const typeTupleAssignment = (
  pattern: HirPattern,
  valueExpr: HirExprId,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (pattern.kind !== "tuple") {
    throw new Error("tuple assignment requires a tuple pattern");
  }
  bindTuplePatternFromExpr(pattern, valueExpr, ctx, state, "assign");
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
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const options = ctx.overloads.get(callee.set);
  if (!options) {
    throw new Error(
      `missing overload metadata for ${callee.name} (set ${callee.set})`
    );
  }

  const matches = options
    .map((symbol) => {
      const signature = ctx.functions.getSignature(symbol);
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
      matchesOverloadSignature(symbol, signature, argTypes, ctx, state)
    );

  if (matches.length === 0) {
    throw new Error(`no overload of ${callee.name} matches argument types`);
  }

  if (matches.length > 1) {
    throw new Error(`ambiguous overload for ${callee.name}`);
  }

  const selected = matches[0]!;
  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for overload resolution at call ${call.id}`
    );
  }
  const targets =
    ctx.callResolution.targets.get(call.id) ?? new Map<string, SymbolId>();
  targets.set(instanceKey, selected.symbol);
  ctx.callResolution.targets.set(call.id, targets);
  ctx.table.setExprType(callee.id, selected.signature.typeId);
  return selected.signature.returnType;
};

const matchesOverloadSignature = (
  symbol: SymbolId,
  signature: FunctionSignature,
  args: readonly Arg[],
  ctx: TypingContext,
  state: TypingState
): boolean => {
  if (signature.parameters.length !== args.length) {
    return false;
  }

  signature.parameters.forEach(({ type }) => {
    if (type === ctx.primitives.unknown) {
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

    if (arg.type === ctx.primitives.unknown) {
      return true;
    }

    return typeSatisfies(arg.type, param.type, ctx, state);
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
    return arg.type === ctx.primitives.unknown || param === arg.type;
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
    effects: ctx.primitives.defaultEffectRow,
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
    { parameters: [int32, int32], returnType: ctx.primitives.bool },
    { parameters: [int64, int64], returnType: ctx.primitives.bool },
    { parameters: [float32, float32], returnType: ctx.primitives.bool },
    { parameters: [float64, float64], returnType: ctx.primitives.bool },
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

const bindTuplePatternFromExpr = (
  pattern: HirPattern & { kind: "tuple" },
  exprId: HirExprId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode
): void => {
  const initializerType = typeExpression(exprId, ctx, state);
  const initializerExpr = ctx.hir.expressions.get(exprId);

  if (initializerExpr?.exprKind === "tuple") {
    if (initializerExpr.elements.length !== pattern.elements.length) {
      throw new Error("tuple pattern length mismatch");
    }

    pattern.elements.forEach((subPattern, index) => {
      const elementExprId = initializerExpr.elements[index]!;
      if (subPattern.kind === "tuple") {
        bindTuplePatternFromExpr(subPattern, elementExprId, ctx, state, mode);
        return;
      }
      const cached = ctx.table.getExprType(elementExprId);
      const elementType =
        typeof cached === "number"
          ? cached
          : typeExpression(elementExprId, ctx, state);
      recordPatternType(subPattern, elementType, ctx, state, mode);
    });
    return;
  }

  bindTuplePatternFromType(pattern, initializerType, ctx, state, mode);
};

type PatternBindingMode = "declare" | "assign";

const recordPatternType = (
  pattern: HirPattern,
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
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
      ensureTypeMatches(type, existing, ctx, state, `assignment to ${getSymbolName(pattern.symbol, ctx)}`);
      return;
    }
    case "wildcard":
      return;
    default:
      throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }
};

const bindTuplePatternFromType = (
  pattern: HirPattern & { kind: "tuple" },
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode
): void => {
  const fields = getStructuralFields(type, ctx, state);
  if (!fields) {
    if (state.mode === "relaxed" && type === ctx.primitives.unknown) {
      pattern.elements.forEach((subPattern) => {
        if (subPattern.kind === "tuple") {
          bindTuplePatternFromType(subPattern, ctx.primitives.unknown, ctx, state, mode);
          return;
        }
        recordPatternType(subPattern, ctx.primitives.unknown, ctx, state, mode);
      });
      return;
    }
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
      bindTuplePatternFromType(subPattern, fieldType, ctx, state, mode);
      return;
    }
    recordPatternType(subPattern, fieldType, ctx, state, mode);
  });
};

const narrowMatchPattern = (
  discriminantType: TypeId,
  pattern: HirPattern,
  ctx: TypingContext,
  state: TypingState,
  reason: string
): TypeId => {
  switch (pattern.kind) {
    case "wildcard":
      pattern.typeId = discriminantType;
      return discriminantType;
    case "type": {
      const patternType = resolveTypeExpr(
        pattern.type,
        ctx,
        state,
        ctx.primitives.unknown
      );
      const narrowed = narrowTypeForPattern(
        discriminantType,
        patternType,
        ctx,
        state
      );
      if (typeof narrowed !== "number") {
        throw new Error(`pattern does not match discriminant for ${reason}`);
      }
      pattern.typeId = narrowed;
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
  if (typeof symbol !== "number" || narrowedType === ctx.primitives.unknown) {
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
