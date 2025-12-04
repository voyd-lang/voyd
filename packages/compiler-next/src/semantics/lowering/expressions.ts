import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  type Syntax,
  formCallsInternal,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../parser/index.js";
import { expectLabeledExpr, parseIfBranches, toSourceSpan } from "../utils.js";
import { parseLambdaSignature } from "../lambda.js";
import type {
  HirCondBranch,
  HirMatchArm,
  HirObjectLiteralEntry,
  HirPattern,
  HirBindingKind,
  HirTypeExpr,
} from "../hir/index.js";
import type { HirExprId, HirStmtId, ScopeId, SymbolId } from "../ids.js";
import {
  resolveIdentifierValue,
  resolveConstructorResolution,
  resolveSymbol,
  resolveTypeSymbol,
} from "./resolution.js";
import { lowerTypeExpr, lowerTypeParameters } from "./type-expressions.js";
import type {
  IdentifierResolution,
  LowerContext,
  LowerObjectLiteralOptions,
  LowerScopeStack,
} from "./types.js";
import {
  extractConstructorTargetIdentifier,
  literalProvidesAllFields,
} from "../constructors.js";

export const lowerExpr = (
  expr: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  if (!expr) {
    throw new Error("expected expression");
  }

  if (isIntAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: expr.intType,
      value: expr.value,
    });
  }

  if (isFloatAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: expr.floatType,
      value: expr.value,
    });
  }

  if (isStringAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: "string",
      value: expr.value,
    });
  }

  if (isBoolAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: "boolean",
      value: expr.value,
    });
  }

  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    const resolution = resolveIdentifierValue(
      expr.value,
      scopes.current(),
      ctx
    );
    if (resolution.kind === "symbol") {
      return ctx.builder.addExpression({
        kind: "expr",
        exprKind: "identifier",
        ast: expr.syntaxId,
        span: toSourceSpan(expr),
        symbol: resolution.symbol,
      });
    }

    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "overload-set",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      name: resolution.name,
      set: resolution.set,
    });
  }

  if (isForm(expr)) {
    if (isObjectLiteralForm(expr)) {
      return lowerObjectLiteralExpr(expr, ctx, scopes);
    }

    if (isArrayLiteralForm(expr)) {
      return lowerArrayLiteralExpr(expr, ctx, scopes);
    }

    if (expr.calls("match")) {
      return lowerMatch(expr, ctx, scopes);
    }

    if (isFieldAccessForm(expr)) {
      return lowerFieldAccessExpr(expr, ctx, scopes);
    }

    if (expr.calls("::")) {
      return lowerStaticAccessExpr(expr, ctx, scopes);
    }

    if (expr.calls(".")) {
      return lowerDotExpr(expr, ctx, scopes);
    }

    if (expr.calls("block")) {
      return lowerBlock(expr, ctx, scopes);
    }

    if (expr.calls("if")) {
      return lowerIf(expr, ctx, scopes);
    }

    if (expr.calls("while")) {
      return lowerWhile(expr, ctx, scopes);
    }

    if (expr.calls("=>")) {
      return lowerLambda(expr, ctx, scopes);
    }

    if (expr.calls("tuple") || expr.callsInternal("tuple")) {
      return lowerTupleExpr(expr, ctx, scopes);
    }

    if (expr.calls("=")) {
      return lowerAssignment(expr, ctx, scopes);
    }

    return lowerCall(expr, ctx, scopes);
  }

  throw new Error(`unsupported expression node: ${expr.location}`);
};

const lowerBlock = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const scopeId = ctx.scopeByNode.get(form.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const statements: HirStmtId[] = [];
  let value: HirExprId | undefined;
  const entries = form.rest;

  entries.forEach((entry, index) => {
    const isStatementForm =
      isForm(entry) && (entry.calls("var") || entry.calls("let"));
    if (isStatementForm) {
      statements.push(lowerLetStatement(entry, ctx, scopes));
      return;
    }

    const exprId = lowerExpr(entry, ctx, scopes);
    const isLast = index === entries.length - 1;
    if (!isLast) {
      const entrySyntax = entry as Syntax | undefined;
      statements.push(
        ctx.builder.addStatement({
          kind: "expr-stmt",
          ast: entrySyntax?.syntaxId ?? form.syntaxId,
          span: toSourceSpan(entrySyntax),
          expr: exprId,
        })
      );
      return;
    }
    value = exprId;
  });

  if (scopeId !== undefined) {
    scopes.pop();
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "block",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    statements,
    value,
  });
};

const lowerIf = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const { branches, defaultBranch } = parseIfBranches(form);
  const loweredBranches: HirCondBranch[] = branches.map(
    ({ condition, value }) => ({
      condition: lowerExpr(condition, ctx, scopes),
      value: lowerExpr(value, ctx, scopes),
    })
  );

  const loweredDefault = defaultBranch
    ? lowerExpr(defaultBranch, ctx, scopes)
    : undefined;

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "if",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    branches: loweredBranches,
    defaultBranch: loweredDefault,
  });
};

const lowerMatch = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack,
  operandOverride?: Expr
): HirExprId => {
  const scopeId = ctx.scopeByNode.get(form.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const operandExpr = operandOverride ?? form.at(1);
  if (!operandExpr) {
    throw new Error("match expression missing discriminant");
  }

  const potentialBinder = operandOverride ? form.at(1) : form.at(2);
  const hasBinder = isIdentifierAtom(potentialBinder);
  const caseStart = hasBinder
    ? operandOverride
      ? 2
      : 3
    : operandOverride
    ? 1
    : 2;

  const operandId = lowerExpr(operandExpr, ctx, scopes);
  const binderSymbol =
    hasBinder && potentialBinder
      ? resolveSymbol(potentialBinder.value, scopes.current(), ctx)
      : undefined;

  const arms: HirMatchArm[] = form
    .toArray()
    .slice(caseStart)
    .map((entry) => lowerMatchArm(entry, ctx, scopes));

  const discriminant =
    typeof binderSymbol === "number"
      ? ctx.builder.addExpression({
          kind: "expr",
          exprKind: "identifier",
          ast:
            (potentialBinder as Syntax | undefined)?.syntaxId ?? form.syntaxId,
          span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
          symbol: binderSymbol,
        })
      : operandId;

  const matchExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "match",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    discriminant,
    arms,
  });

  if (scopeId !== undefined) {
    scopes.pop();
  }

  if (typeof binderSymbol === "number") {
    const binderPattern: HirPattern = {
      kind: "identifier",
      symbol: binderSymbol,
      span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
    };
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "block",
      ast: form.syntaxId,
      span: toSourceSpan(form),
      statements: [
        ctx.builder.addStatement({
          kind: "let",
          ast:
            (potentialBinder as Syntax | undefined)?.syntaxId ?? form.syntaxId,
          span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
          mutable: false,
          pattern: binderPattern,
          initializer: operandId,
        }),
      ],
      value: matchExpr,
    });
  }

  return matchExpr;
};

const lowerMatchArm = (
  entry: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirMatchArm => {
  if (!isForm(entry) || !entry.calls(":")) {
    throw new Error("match cases must be labeled with ':'");
  }

  const scopeId = ctx.scopeByNode.get(entry.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const patternExpr = entry.at(1);
  const valueExpr = entry.at(2);
  if (!valueExpr) {
    throw new Error("match case missing value expression");
  }

  const pattern = lowerMatchPattern(patternExpr, ctx, scopes);
  const value = lowerExpr(valueExpr, ctx, scopes);

  if (scopeId !== undefined) {
    scopes.pop();
  }

  return { pattern, value };
};

const lowerMatchPattern = (
  pattern: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirPattern => {
  if (!pattern) {
    throw new Error("match case missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_" || pattern.value === "else") {
      return { kind: "wildcard", span: toSourceSpan(pattern) };
    }
    const type = lowerTypeExpr(pattern, ctx, scopes.current());
    if (!type) {
      throw new Error("match pattern missing type");
    }
    return { kind: "type", type, span: toSourceSpan(pattern) };
  }

  const type = lowerTypeExpr(pattern, ctx, scopes.current());
  if (type) {
    return { kind: "type", type, span: toSourceSpan(pattern) };
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    const elements = pattern.rest.map((entry) =>
      lowerMatchPattern(entry, ctx, scopes)
    );
    return { kind: "tuple", elements, span: toSourceSpan(pattern) };
  }

  throw new Error("unsupported match pattern");
};

const lowerCallFromElements = (
  calleeExpr: Expr,
  argsExprs: readonly Expr[],
  ast: Syntax,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const potentialGenerics = argsExprs[0];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const calleeId = lowerExpr(calleeExpr, ctx, scopes);
  const args = argsExprs.slice(hasTypeArguments ? 1 : 0).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    callee: calleeId,
    args,
    typeArguments,
  });
};

const lowerNominalObjectLiteral = (
  callee: Expr,
  args: readonly Expr[],
  ast: Syntax,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId | undefined => {
  if (!isIdentifierAtom(callee) || args.length === 0) {
    return undefined;
  }

  const genericsForm = args[0];
  const hasGenerics =
    isForm(genericsForm) && formCallsInternal(genericsForm, "generics");
  const literalArgIndex = hasGenerics ? 1 : 0;
  const literalArg = args[literalArgIndex];
  if (!literalArg || !isForm(literalArg) || !isObjectLiteralForm(literalArg)) {
    return undefined;
  }

  const typeArguments = hasGenerics
    ? ((genericsForm as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const symbol = resolveTypeSymbol(callee.value, scopes.current(), ctx);
  if (typeof symbol !== "number") {
    return undefined;
  }
  const metadata = (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
    entity?: string;
  };
  const constructors = ctx.staticMethods.get(symbol)?.get("init");
  if (metadata.entity !== "object" && !(constructors && constructors.size > 0)) {
    return undefined;
  }
  if (constructors && constructors.size > 0) {
    const decl = ctx.decls.getObject(symbol);
    const providesAllFields =
      decl && literalProvidesAllFields(literalArg, decl.fields);
    if (!providesAllFields) {
      return lowerConstructorLiteralCall({
        callee,
        literal: literalArg,
        typeArguments,
        targetSymbol: symbol,
        ctx,
        scopes,
        ast,
      });
    }
  }

  const target = {
    typeKind: "named" as const,
    path: [callee.value],
    symbol,
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    typeArguments,
  };

  return lowerObjectLiteralExpr(literalArg, ctx, scopes, {
    literalKind: "nominal",
    target,
    targetSymbol: symbol,
  });
};

const lowerCall = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const callee = form.at(0);
  if (!callee) {
    throw new Error("call expression missing callee");
  }

  if (isIdentifierAtom(callee) && callee.value === "~") {
    const targetCallee = form.at(1);
    if (!targetCallee) {
      throw new Error("~ expression missing target");
    }
    const innerArgs = form.rest.slice(1);
    const nominal = lowerNominalObjectLiteral(
      targetCallee,
      innerArgs,
      form,
      ctx,
      scopes
    );
    const valueExpr =
      typeof nominal === "number"
        ? nominal
        : lowerCallFromElements(targetCallee, innerArgs, form, ctx, scopes);
    const loweredCallee = lowerExpr(callee, ctx, scopes);
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "call",
      ast: form.syntaxId,
      span: toSourceSpan(form),
      callee: loweredCallee,
      args: [{ expr: valueExpr }],
    });
  }

  const nominalLiteral = lowerNominalObjectLiteral(
    callee,
    form.rest,
    form,
    ctx,
    scopes
  );
  if (typeof nominalLiteral === "number") {
    return nominalLiteral;
  }

  return lowerCallFromElements(callee, form.rest, form, ctx, scopes);
};

const lowerLetStatement = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirStmtId => {
  const isVar = form.calls("var");
  const isLet = form.calls("let");
  const assignment = form.at(1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    throw new Error("let/var statement expects an assignment");
  }

  const patternExpr = assignment.at(1);
  const initializerExpr = assignment.at(2);
  if (!initializerExpr) {
    throw new Error("let/var statement missing initializer");
  }

  const pattern = lowerPattern(patternExpr, ctx, scopes);
  const initializer = lowerExpr(initializerExpr, ctx, scopes);

  return ctx.builder.addStatement({
    kind: "let",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    mutable: isVar && !isLet,
    pattern,
    initializer,
  });
};

const lowerPattern = (
  pattern: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirPattern => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  const { target, bindingKind } = unwrapMutablePattern(pattern);

  if (isIdentifierAtom(target)) {
    if (target.value === "_") {
      return { kind: "wildcard", span: toSourceSpan(pattern) };
    }
    const symbol = resolveSymbol(target.value, scopes.current(), ctx);
    return {
      kind: "identifier",
      symbol,
      span: toSourceSpan(pattern),
      bindingKind,
    };
  }

  if (
    isForm(target) &&
    (target.calls("tuple") || target.callsInternal("tuple"))
  ) {
    if (bindingKind && bindingKind !== "value") {
      throw new Error("mutable reference patterns must bind identifiers");
    }
    const elements = target.rest.map((entry) =>
      lowerPattern(entry, ctx, scopes)
    );
    return { kind: "tuple", elements, span: toSourceSpan(pattern) };
  }

  if (isForm(target) && target.calls(":")) {
    const nameExpr = target.at(1);
    const typeExpr = target.at(2);
    if (!typeExpr) {
      throw new Error("typed pattern is missing a type annotation");
    }
    const { target: nameTarget, bindingKind: nameBinding } =
      unwrapMutablePattern(nameExpr);
    const lowered = lowerPattern(nameTarget, ctx, scopes);
    const typeAnnotation = lowerTypeExpr(typeExpr, ctx, scopes.current());
    return {
      ...lowered,
      typeAnnotation,
      bindingKind: nameBinding ?? lowered.bindingKind ?? bindingKind,
      span: lowered.span ?? toSourceSpan(pattern),
    };
  }

  throw new Error("unsupported pattern form");
};

const unwrapMutablePattern = (
  pattern?: Expr
): { target: Expr; bindingKind?: HirBindingKind } => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isForm(pattern) && pattern.calls("~")) {
    const target = pattern.at(1);
    if (!target) {
      throw new Error("mutable pattern missing target");
    }
    return { target, bindingKind: "mutable-ref" };
  }

  return { target: pattern };
};

const lowerTupleExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const elements = form.rest.map((entry) => lowerExpr(entry, ctx, scopes));
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "tuple",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    elements,
  });
};

export const isObjectLiteralForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

const isArrayLiteralForm = (form: Form): boolean =>
  form.callsInternal("array_literal");

const lowerArrayLiteralExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const callee = resolveSymbol("fixed_array_literal", scopes.current(), ctx);
  const calleeExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "identifier",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    symbol: callee,
  });

  const args = form.rest.map((entry) => ({
    expr: lowerExpr(entry, ctx, scopes),
  }));

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: calleeExpr,
    args,
  });
};

const lowerObjectLiteralExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack,
  options: LowerObjectLiteralOptions = {}
): HirExprId => {
  const entries = form.rest.map((entry) =>
    lowerObjectLiteralEntry(entry, ctx, scopes)
  );
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    literalKind: options.literalKind ?? "structural",
    target: options.target,
    targetSymbol: options.targetSymbol,
    entries,
  });
};

const lowerObjectLiteralEntry = (
  entry: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirObjectLiteralEntry => {
  if (!entry) {
    throw new Error("object literal entry missing expression");
  }

  if (isForm(entry) && entry.calls("...")) {
    const valueExpr = entry.at(1);
    if (!valueExpr) {
      throw new Error("spread entry missing value");
    }
    return {
      kind: "spread",
      value: lowerExpr(valueExpr, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  if (isForm(entry) && entry.calls(":")) {
    const nameExpr = entry.at(1);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("object literal field name must be an identifier");
    }
    const valueExpr = entry.at(2);
    if (!valueExpr) {
      throw new Error("object literal field missing value");
    }
    return {
      kind: "field",
      name: nameExpr.value,
      value: lowerExpr(valueExpr, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  if (isIdentifierAtom(entry)) {
    return {
      kind: "field",
      name: entry.value,
      value: lowerExpr(entry, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  throw new Error("unsupported object literal entry");
};

const lowerConstructorLiteralCall = ({
  callee,
  literal,
  typeArguments,
  targetSymbol,
  ctx,
  scopes,
  ast,
}: {
  callee: IdentifierAtom;
  literal: Form;
  typeArguments?: HirTypeExpr[];
  targetSymbol: SymbolId;
  ctx: LowerContext;
  scopes: LowerScopeStack;
  ast: Syntax;
}): HirExprId => {
  const methodTable = ctx.staticMethods.get(targetSymbol);
  if (!methodTable) {
    const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
    throw new Error(`type ${targetName} does not declare constructors`);
  }
  const resolution = resolveStaticMethodResolution({
    name: "init",
    targetSymbol,
    methodTable,
    ctx,
  });
  const calleeExpr = lowerResolvedCallee({
    resolution,
    syntax: callee,
    ctx,
  });
  const args = literal.rest.map((entry) =>
    lowerConstructorArgFromEntry(entry, ctx, scopes)
  );

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    callee: calleeExpr,
    args,
    typeArguments:
      typeArguments && typeArguments.length > 0 ? typeArguments : undefined,
  });
};

const lowerConstructorArgFromEntry = (
  entry: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): { label?: string; expr: HirExprId } => {
  if (!entry) {
    throw new Error("constructor argument missing expression");
  }

  if (isForm(entry) && entry.calls("...")) {
    const valueExpr = entry.at(1);
    if (!valueExpr) {
      throw new Error("spread constructor argument missing value");
    }
    return { expr: lowerExpr(valueExpr, ctx, scopes) };
  }

  if (isForm(entry) && entry.calls(":")) {
    const nameExpr = entry.at(1);
    const valueExpr = entry.at(2);
    if (!isIdentifierAtom(nameExpr) || !valueExpr) {
      throw new Error("constructor literal argument must name a field");
    }
    return {
      label: nameExpr.value,
      expr: lowerExpr(valueExpr, ctx, scopes),
    };
  }

  if (isIdentifierAtom(entry) || isInternalIdentifierAtom(entry)) {
    return {
      label: entry.value,
      expr: lowerExpr(entry, ctx, scopes),
    };
  }

  throw new Error("unsupported constructor literal entry");
};

const isFieldAccessForm = (form: Form): boolean => {
  if (!form.calls(".") || form.length !== 3) {
    return false;
  }
  const targetExpr = form.at(1);
  const fieldExpr = form.at(2);
  return !!targetExpr && isIdentifierAtom(fieldExpr);
};

const lowerFieldAccessExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const targetExpr = form.at(1);
  const fieldExpr = form.at(2);
  if (!targetExpr || !isIdentifierAtom(fieldExpr)) {
    throw new Error("invalid field access expression");
  }
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "field-access",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    field: fieldExpr.value,
    target: lowerExpr(targetExpr, ctx, scopes),
  });
};

const lowerStaticAccessExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const targetExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!targetExpr || !memberExpr) {
    throw new Error("static access expression missing target or member");
  }

  const targetSymbol = resolveStaticTargetSymbol(
    targetExpr,
    scopes.current(),
    ctx
  );
  if (typeof targetSymbol === "number") {
    const targetTypeArguments = extractStaticTargetTypeArguments({
      targetExpr,
      ctx,
      scopes,
    });
    const methodTable = ctx.staticMethods.get(targetSymbol);
    if (!methodTable) {
      const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
      throw new Error(`type ${targetName} does not declare static methods`);
    }

    if (isForm(memberExpr)) {
      return lowerStaticMethodCall({
        accessForm: form,
        memberForm: memberExpr,
        methodTable,
        targetSymbol,
        targetTypeArguments,
        ctx,
        scopes,
      });
    }

    if (isIdentifierAtom(memberExpr) || isInternalIdentifierAtom(memberExpr)) {
      const resolution = resolveStaticMethodResolution({
        name: memberExpr.value,
        targetSymbol,
        methodTable,
        ctx,
      });
      return lowerResolvedCallee({
        resolution,
        syntax: memberExpr,
        ctx,
      });
    }
    throw new Error("unsupported static access expression");
  }

  const moduleAccess = lowerModuleAccess({
    accessForm: form,
    targetExpr,
    memberExpr,
    ctx,
    scopes,
  });
  if (typeof moduleAccess === "number") {
    return moduleAccess;
  }

  throw new Error("static access target must be a type or module");
};

const lowerModuleAccess = ({
  accessForm,
  targetExpr,
  memberExpr,
  ctx,
  scopes,
}: {
  accessForm: Form;
  targetExpr: Expr;
  memberExpr: Expr;
  ctx: LowerContext;
  scopes: LowerScopeStack;
}): HirExprId | undefined => {
  const moduleSymbol = resolveModuleSymbol(targetExpr, scopes.current(), ctx);
  if (typeof moduleSymbol !== "number") {
    return undefined;
  }
  const memberName = extractModuleMemberName(memberExpr);
  if (!memberName) {
    return undefined;
  }
  const memberTable = ctx.moduleMembers.get(moduleSymbol);
  if (!memberTable) {
    const targetName = ctx.symbolTable.getSymbol(moduleSymbol).name;
    throw new Error(`module ${targetName} does not expose members`);
  }

  if (isForm(memberExpr)) {
    return lowerModuleQualifiedCall({
      accessForm,
      memberForm: memberExpr,
      memberTable,
      moduleSymbol,
      ctx,
      scopes,
    });
  }

  const resolution = resolveModuleMemberResolution({
    name: memberName,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution) {
    return undefined;
  }
  return lowerResolvedCallee({
    resolution,
    syntax: memberExpr as Syntax,
    ctx,
  });
};

const extractModuleMemberName = (expr: Expr | undefined): string | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }
  if (!isForm(expr)) {
    return undefined;
  }
  const head = expr.at(0);
  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    return head.value;
  }
  return undefined;
};

const lowerStaticMethodCall = ({
  accessForm,
  memberForm,
  methodTable,
  targetSymbol,
  targetTypeArguments,
  ctx,
  scopes,
}: {
  accessForm: Form;
  memberForm: Form;
  methodTable: ReadonlyMap<string, Set<SymbolId>>;
  targetSymbol: SymbolId;
  targetTypeArguments?: HirTypeExpr[];
  ctx: LowerContext;
  scopes: LowerScopeStack;
}): HirExprId => {
  const elements = memberForm.toArray();
  if (elements.length === 0) {
    throw new Error("static method call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (
    !isIdentifierAtom(calleeExpr) &&
    !isInternalIdentifierAtom(calleeExpr)
  ) {
    throw new Error("static method name must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;
  const combinedTypeArguments =
    targetTypeArguments && targetTypeArguments.length > 0
      ? [
          ...(typeArguments ?? []),
          ...(targetTypeArguments.filter(Boolean) as HirTypeExpr[]),
        ]
      : typeArguments;

  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  const resolution = resolveStaticMethodResolution({
    name: calleeExpr.value,
    targetSymbol,
    methodTable,
    ctx,
  });
  const callee = lowerResolvedCallee({
    resolution,
    syntax: calleeExpr,
    ctx,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: accessForm.syntaxId,
    span: toSourceSpan(accessForm),
    callee,
    args,
    typeArguments:
      combinedTypeArguments && combinedTypeArguments.length > 0
        ? combinedTypeArguments
        : undefined,
  });
};

const lowerModuleQualifiedCall = ({
  accessForm,
  memberForm,
  memberTable,
  moduleSymbol,
  ctx,
  scopes,
}: {
  accessForm: Form;
  memberForm: Form;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  moduleSymbol: SymbolId;
  ctx: LowerContext;
  scopes: LowerScopeStack;
}): HirExprId => {
  const elements = memberForm.toArray();
  if (elements.length === 0) {
    throw new Error("module-qualified call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (
    !isIdentifierAtom(calleeExpr) &&
    !isInternalIdentifierAtom(calleeExpr)
  ) {
    throw new Error("module-qualified callee must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  const nominal = lowerNominalObjectLiteral(
    calleeExpr,
    memberForm.rest,
    accessForm,
    ctx,
    scopes
  );
  if (typeof nominal === "number") {
    return nominal;
  }

  const resolution = resolveModuleMemberCallResolution({
    name: calleeExpr.value,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution) {
    const moduleName = ctx.symbolTable.getSymbol(moduleSymbol).name;
    throw new Error(
      `module ${moduleName} does not export ${calleeExpr.value}`
    );
  }

  const callee = lowerResolvedCallee({
    resolution,
    syntax: calleeExpr,
    ctx,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: accessForm.syntaxId,
    span: toSourceSpan(accessForm),
    callee,
    args,
    typeArguments,
  });
};

const lowerResolvedCallee = ({
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

const resolveStaticMethodResolution = ({
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
  throw new Error(`ambiguous static method ${name} for type ${targetName}`);
};

const resolveModuleMemberResolution = ({
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
  throw new Error(`ambiguous module member ${name} on ${moduleName}`);
};

const resolveModuleMemberCallResolution = ({
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

const resolveModuleSymbol = (
  expr: Expr,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    const symbol = resolveSymbol(expr.value, scope, ctx);
    if (typeof symbol === "number") {
      const record = ctx.symbolTable.getSymbol(symbol);
      if (record.kind === "module") {
        return symbol;
      }
    }
  }
  return undefined;
};

const resolveStaticTargetSymbol = (
  expr: Expr,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  const identifier = extractConstructorTargetIdentifier(expr);
  if (!identifier) {
    return undefined;
  }
  return resolveTypeSymbol(identifier.value, scope, ctx);
};

const extractStaticTargetTypeArguments = ({
  targetExpr,
  ctx,
  scopes,
}: {
  targetExpr: Expr;
  ctx: LowerContext;
  scopes: LowerScopeStack;
}): HirTypeExpr[] | undefined => {
  const genericArgs = extractTypeArgumentForms(targetExpr);
  if (!genericArgs || genericArgs.length === 0) {
    return undefined;
  }
  const typeArguments = genericArgs
    .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
    .filter(Boolean) as HirTypeExpr[];
  return typeArguments.length > 0 ? typeArguments : undefined;
};

const extractTypeArgumentForms = (
  expr: Expr
): readonly Expr[] | undefined => {
  if (isForm(expr) && isIdentifierAtom(expr.first)) {
    if (
      isForm(expr.second) &&
      formCallsInternal(expr.second, "generics")
    ) {
      return expr.second.rest;
    }
    return undefined;
  }

  if (isForm(expr) && formCallsInternal(expr, "generics")) {
    return expr.rest;
  }

  return undefined;
};

const lowerDotExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const targetExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!targetExpr || !memberExpr) {
    throw new Error("dot expression missing target or member");
  }

  if (isForm(memberExpr) && memberExpr.calls("match")) {
    return lowerMatch(memberExpr, ctx, scopes, targetExpr);
  }

  if (isForm(memberExpr) && memberExpr.calls("=>")) {
    return lowerCallFromElements(memberExpr, [targetExpr], form, ctx, scopes);
  }

  if (isForm(memberExpr)) {
    return lowerMethodCallExpr(form, memberExpr, targetExpr, ctx, scopes);
  }

  throw new Error("unsupported dot expression");
};

const lowerMethodCallExpr = (
  dotForm: Form,
  memberForm: Form,
  targetExpr: Expr,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const elements = memberForm.toArray();
  if (!elements.length) {
    throw new Error("method access missing callee");
  }

  const calleeExpr = elements[0]!;
  const potentialGenerics = elements[1];
  const hasGenerics =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const argsStartIndex = hasGenerics ? 2 : 1;
  const args = elements.slice(argsStartIndex);
  const callArgs: Expr[] = hasGenerics
    ? [potentialGenerics!, targetExpr, ...args]
    : [targetExpr, ...args];

  return lowerCallFromElements(calleeExpr, callArgs, dotForm, ctx, scopes);
};

const lowerAssignment = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const targetExpr = form.at(1);
  const valueExpr = form.at(2);
  if (!targetExpr || !valueExpr) {
    throw new Error("assignment requires target and value");
  }

  let target: HirExprId | undefined;
  let pattern: HirPattern | undefined;

  if (
    isForm(targetExpr) &&
    (targetExpr.calls("tuple") || targetExpr.callsInternal("tuple"))
  ) {
    pattern = lowerPattern(targetExpr, ctx, scopes);
  } else {
    target = lowerExpr(targetExpr, ctx, scopes);
  }

  const value = lowerExpr(valueExpr, ctx, scopes);

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "assign",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    target,
    pattern,
    value,
  });
};

const lowerWhile = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error("while expression missing condition");
  }

  const bodyExpr = expectLabeledExpr(form.at(2), "do", "while expression");

  const condition = lowerExpr(conditionExpr, ctx, scopes);
  const body = lowerExpr(bodyExpr, ctx, scopes);

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "while",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    condition,
    body,
  });
};

const lowerLambda = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const signatureExpr = form.at(1);
  const bodyExpr = form.at(2);
  if (!signatureExpr || !bodyExpr) {
    throw new Error("lambda expression missing signature or body");
  }

  const lambdaScope = ctx.scopeByNode.get(form.syntaxId);
  if (lambdaScope !== undefined) {
    scopes.push(lambdaScope);
  }

  const signature = parseLambdaSignature(signatureExpr);
  const parameters = signature.parameters.map((param) =>
    lowerLambdaParameter(param, ctx, scopes)
  );

  const typeParameters = lowerTypeParameters(
    signature.typeParameters?.map((param) => {
      const symbol = resolveTypeSymbol(param.value, scopes.current(), ctx);
      if (!symbol) {
        throw new Error(`unknown type parameter ${param.value} in lambda`);
      }
      return { symbol, ast: param };
    })
  );

  const returnType = lowerTypeExpr(signature.returnType, ctx, scopes.current());
  const effectType = lowerTypeExpr(signature.effectType, ctx, scopes.current());
  const body = lowerExpr(bodyExpr, ctx, scopes);

  if (lambdaScope !== undefined) {
    scopes.pop();
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "lambda",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    typeParameters,
    parameters,
    returnType,
    effectType,
    body,
    captures: [],
  });
};

const lowerLambdaParameter = (
  param: Expr,
  ctx: LowerContext,
  scopes: LowerScopeStack
) => {
  const { target, bindingKind } = unwrapMutablePattern(param);

  if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
    const symbol = resolveSymbol(target.value, scopes.current(), ctx);
    return {
      symbol,
      pattern: {
        kind: "identifier",
        symbol,
        span: toSourceSpan(param),
        bindingKind,
      },
      mutable: false,
      span: toSourceSpan(param),
    };
  }

  if (isForm(target) && target.calls(":")) {
    const nameExpr = target.at(1);
    const { target: nameTarget, bindingKind: nameBinding } =
      unwrapMutablePattern(nameExpr);
    if (
      !isIdentifierAtom(nameTarget) &&
      !isInternalIdentifierAtom(nameTarget)
    ) {
      throw new Error("lambda parameter name must be an identifier");
    }
    const symbol = resolveSymbol(nameTarget.value, scopes.current(), ctx);
    return {
      symbol,
      pattern: {
        kind: "identifier",
        symbol,
        span: toSourceSpan(param),
        bindingKind: nameBinding ?? bindingKind,
      },
      mutable: false,
      span: toSourceSpan(param),
      type: lowerTypeExpr(target.at(2), ctx, scopes.current()),
    };
  }

  if (isForm(target)) {
    const nestedParams = target
      .toArray()
      .map((entry) => lowerLambdaParameter(entry, ctx, scopes));
    if (nestedParams.length !== 1) {
      throw new Error("unexpected nested lambda parameter structure");
    }
    return nestedParams[0]!;
  }

  throw new Error("unsupported lambda parameter form");
};
