import {
  type Expr,
  type Form,
  type Syntax,
  formCallsInternal,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../parser/index.js";
import type { SymbolTable } from "../binder/index.js";
import type {
  HirExprId,
  HirStmtId,
  NodeId,
  OverloadSetId,
  ScopeId,
  SymbolId,
} from "../ids.js";
import type {
  HirBuilder,
  HirCondBranch,
  HirGraph,
  HirMatchArm,
  HirObjectLiteralEntry,
  HirParameter,
  HirPattern,
  HirRecordTypeField,
  HirTypeExpr,
  HirTypeParameter,
} from "../hir/index.js";
import type {
  BoundFunction,
  BoundTypeAlias,
  BindingResult,
  BoundObject,
} from "../binding/pipeline.js";
import { expectLabeledExpr, parseIfBranches, toSourceSpan } from "../utils.js";

interface LowerInputs {
  builder: HirBuilder;
  binding: BindingResult;
  moduleNodeId: NodeId;
}

interface LowerScopeStack {
  current(): ScopeId;
  push(scope: ScopeId): void;
  pop(): void;
}

interface LowerContext {
  builder: HirBuilder;
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  intrinsicSymbols: Map<string, SymbolId>;
  moduleNodeId: NodeId;
  overloadBySymbol: ReadonlyMap<SymbolId, OverloadSetId>;
}

type IdentifierResolution =
  | { kind: "symbol"; symbol: SymbolId; name: string }
  | { kind: "overload-set"; name: string; set: OverloadSetId };

type ModuleDeclaration =
  | { kind: "function"; order: number; fn: BoundFunction }
  | { kind: "type-alias"; order: number; alias: BoundTypeAlias }
  | { kind: "object"; order: number; object: BoundObject };

const getModuleDeclarations = (binding: BindingResult): ModuleDeclaration[] => {
  const entries: ModuleDeclaration[] = [
    ...binding.functions.map((fn) => ({
      kind: "function" as const,
      order: fn.moduleIndex,
      fn,
    })),
    ...binding.typeAliases.map((alias) => ({
      kind: "type-alias" as const,
      order: alias.moduleIndex,
      alias,
    })),
    ...binding.objects.map((object) => ({
      kind: "object" as const,
      order: object.moduleIndex,
      object,
    })),
  ];

  return entries.sort((a, b) => a.order - b.order);
};

export const runLoweringPipeline = (inputs: LowerInputs): HirGraph => {
  const intrinsicSymbols = new Map<string, SymbolId>();

  const declarations = getModuleDeclarations(inputs.binding);

  for (const decl of declarations) {
    if (decl.kind === "function") {
      lowerFunction(decl.fn, {
        builder: inputs.builder,
        symbolTable: inputs.binding.symbolTable,
        scopeByNode: inputs.binding.scopeByNode,
        intrinsicSymbols,
        moduleNodeId: inputs.moduleNodeId,
        overloadBySymbol: inputs.binding.overloadBySymbol,
      });
      continue;
    }

    if (decl.kind === "object") {
      lowerObjectDecl(decl.object, {
        builder: inputs.builder,
        symbolTable: inputs.binding.symbolTable,
        scopeByNode: inputs.binding.scopeByNode,
        intrinsicSymbols,
        moduleNodeId: inputs.moduleNodeId,
        overloadBySymbol: inputs.binding.overloadBySymbol,
      });
      continue;
    }

    lowerTypeAlias(decl.alias, {
      builder: inputs.builder,
      symbolTable: inputs.binding.symbolTable,
      scopeByNode: inputs.binding.scopeByNode,
      intrinsicSymbols,
      moduleNodeId: inputs.moduleNodeId,
      overloadBySymbol: inputs.binding.overloadBySymbol,
    });
  }

  return inputs.builder.finalize();
};

const lowerFunction = (fn: BoundFunction, ctx: LowerContext): void => {
  const scopes = createLowerScopeStack(fn.scope);
  const fallbackSyntax = fn.form ?? fn.body;

  const parameters: HirParameter[] = fn.params.map((param) => ({
    decl: param.id,
    symbol: param.symbol,
    pattern: { kind: "identifier", symbol: param.symbol } as const,
    label: param.label,
    span: toSourceSpan(param.ast ?? fallbackSyntax),
    mutable: false,
    type: lowerTypeExpr(param.typeExpr, ctx, scopes.current()),
  }));

  const bodyId = lowerExpr(fn.body, ctx, scopes);
  const fnId = ctx.builder.addFunction({
    kind: "function",
    decl: fn.id,
    visibility: fn.visibility,
    symbol: fn.symbol,
    ast: (fn.form ?? fn.body).syntaxId,
    span: toSourceSpan(fallbackSyntax),
    parameters,
    returnType: lowerTypeExpr(fn.returnTypeExpr, ctx, scopes.current()),
    body: bodyId,
  });

  if (fn.visibility === "public") {
    ctx.builder.recordExport({
      symbol: fn.symbol,
      visibility: "public",
      span: toSourceSpan(fn.form),
      item: fnId,
    });
  }
};

const lowerTypeAlias = (alias: BoundTypeAlias, ctx: LowerContext): void => {
  const target = lowerTypeExpr(alias.target, ctx);
  if (!target) {
    throw new Error("type alias requires a target type expression");
  }

  const aliasSyntax = alias.form ?? alias.target;

  const aliasId = ctx.builder.addItem({
    kind: "type-alias",
    decl: alias.id,
    symbol: alias.symbol,
    visibility: alias.visibility,
    ast: aliasSyntax.syntaxId,
    span: toSourceSpan(aliasSyntax),
    target,
  });

  if (alias.visibility === "public") {
    ctx.builder.recordExport({
      symbol: alias.symbol,
      visibility: alias.visibility,
      span: toSourceSpan(alias.form),
      item: aliasId,
    });
  }
};

const lowerObjectDecl = (object: BoundObject, ctx: LowerContext): void => {
  const objectScope =
    (object.form && ctx.scopeByNode.get(object.form.syntaxId)) ??
    ctx.symbolTable.rootScope;

  const fields = object.fields.map((field) => ({
    name: field.name,
    symbol: field.symbol,
    type: lowerTypeExpr(field.typeExpr, ctx, objectScope),
    span: toSourceSpan(field.ast ?? object.form),
  }));

  const base = lowerTypeExpr(object.baseTypeExpr, ctx, objectScope);
  const baseSymbol =
    base && base.typeKind === "named" ? base.symbol : undefined;

  const objectSyntax =
    object.form ?? object.baseTypeExpr ?? object.fields[0]?.ast;
  if (!objectSyntax) {
    throw new Error("object declaration missing source syntax");
  }

  const objectId = ctx.builder.addItem({
    kind: "object",
    symbol: object.symbol,
    visibility: object.visibility,
    typeParameters: lowerTypeParameters(object.typeParameters),
    ast: objectSyntax.syntaxId,
    span: toSourceSpan(objectSyntax),
    base,
    baseSymbol,
    fields,
    isFinal: false,
  });

  if (object.visibility === "public") {
    ctx.builder.recordExport({
      symbol: object.symbol,
      visibility: object.visibility,
      span: toSourceSpan(object.form),
      item: objectId,
    });
  }
};

const lowerTypeParameters = (
  params: readonly { symbol: SymbolId; ast?: Syntax }[] | undefined
): HirTypeParameter[] | undefined => {
  if (!params || params.length === 0) {
    return undefined;
  }

  return params.map((param) => ({
    symbol: param.symbol,
    span: toSourceSpan(param.ast),
  }));
};

const createLowerScopeStack = (initial: ScopeId): LowerScopeStack => {
  const stack: ScopeId[] = [initial];

  return {
    current: () => stack[stack.length - 1]!,
    push: (scope: ScopeId) => stack.push(scope),
    pop: () => {
      if (stack.length > 1) {
        stack.pop();
      }
    },
  };
};

const lowerExpr = (
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

  if (isIdentifierAtom(expr)) {
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

    if (expr.calls("match")) {
      return lowerMatch(expr, ctx, scopes);
    }

    if (isFieldAccessForm(expr)) {
      return lowerFieldAccessExpr(expr, ctx, scopes);
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

    // TODO: tuple should probably be consistently *not* internal
    if (expr.calls("tuple") || expr.callsInternal("tuple")) {
      return lowerTupleExpr(expr, ctx, scopes);
    }

    if (expr.calls("=")) {
      return lowerAssignment(expr, ctx, scopes);
    }

    return lowerCall(expr, ctx, scopes);
  }

  throw new Error(`unsupported expression node: ${expr}`);
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
      return { kind: "wildcard" };
    }
    const type = lowerTypeExpr(pattern, ctx, scopes.current());
    if (!type) {
      throw new Error("match pattern missing type");
    }
    return { kind: "type", type };
  }

  const type = lowerTypeExpr(pattern, ctx, scopes.current());
  if (type) {
    return { kind: "type", type };
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    const elements = pattern.rest.map((entry) =>
      lowerMatchPattern(entry, ctx, scopes)
    );
    return { kind: "tuple", elements };
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
  const calleeId = lowerExpr(calleeExpr, ctx, scopes);
  const args = argsExprs.map((arg) => {
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
    ? (genericsForm as Form).rest.map((entry) =>
        lowerTypeExpr(entry, ctx, scopes.current())
      )
    : undefined;

  const symbol = resolveTypeSymbol(callee.value, scopes.current(), ctx);
  if (typeof symbol !== "number") {
    return undefined;
  }
  const metadata = (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
    entity?: string;
  };
  if (metadata.entity !== "object") {
    return undefined;
  }

  const target: HirTypeExpr = {
    typeKind: "named",
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

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_") {
      return { kind: "wildcard" };
    }
    const symbol = resolveSymbol(pattern.value, scopes.current(), ctx);
    return {
      kind: "identifier",
      symbol,
    };
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    const elements = pattern.rest.map((entry) =>
      lowerPattern(entry, ctx, scopes)
    );
    return { kind: "tuple", elements };
  }

  if (isForm(pattern) && pattern.calls(":")) {
    const nameExpr = pattern.at(1);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("typed pattern name must be an identifier");
    }
    const symbol = resolveSymbol(nameExpr.value, scopes.current(), ctx);
    return { kind: "identifier", symbol };
  }

  throw new Error("unsupported pattern form");
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

const isObjectLiteralForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

const lowerObjectLiteralExpr = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack,
  options: {
    literalKind?: "structural" | "nominal";
    target?: HirTypeExpr;
    targetSymbol?: SymbolId;
  } = {}
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

const lowerTypeExpr = (
  expr: Expr | undefined,
  ctx: LowerContext,
  scope?: ScopeId
): HirTypeExpr | undefined => {
  if (!expr) return undefined;

  if (isIdentifierAtom(expr)) {
    return lowerNamedType(expr, ctx, scope ?? ctx.symbolTable.rootScope);
  }

  if (isForm(expr) && isObjectLiteralForm(expr)) {
    return lowerObjectTypeExpr(expr, ctx, scope);
  }

  if (isForm(expr) && (expr.calls("tuple") || expr.callsInternal("tuple"))) {
    return lowerTupleTypeExpr(expr, ctx, scope);
  }

  if (isForm(expr) && expr.calls("|")) {
    return lowerUnionTypeExpr(expr, ctx, scope);
  }

  if (isForm(expr)) {
    const named = lowerNamedTypeForm(expr, ctx, scope ?? ctx.symbolTable.rootScope);
    if (named) {
      return named;
    }
  }

  throw new Error("unsupported type expression");
};

const lowerNamedType = (
  atom: IdentifierAtom,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr => ({
  typeKind: "named",
  ast: atom.syntaxId,
  span: toSourceSpan(atom),
  path: [atom.value],
  symbol: resolveTypeSymbol(atom.value, scope, ctx),
});

const lowerNamedTypeForm = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr | undefined => {
  if (
    !isIdentifierAtom(form.at(0)) ||
    !isForm(form.at(1)) ||
    !formCallsInternal(form.at(1) as Form, "generics")
  ) {
    return undefined;
  }

  const name = form.at(0) as IdentifierAtom;
  const genericsForm = form.at(1) as Form;
  const typeArguments = genericsForm.rest.map((entry) =>
    lowerTypeExpr(entry, ctx, scope)
  );

  return {
    typeKind: "named",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    path: [name.value],
    symbol: resolveTypeSymbol(name.value, scope, ctx),
    typeArguments,
  };
};

const lowerObjectTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope?: ScopeId
): HirTypeExpr => {
  const fields = form.rest.map((entry) => lowerObjectTypeField(entry, ctx, scope));
  return {
    typeKind: "object",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    fields,
  };
};

const lowerObjectTypeField = (
  entry: Expr | undefined,
  ctx: LowerContext,
  scope?: ScopeId
): HirRecordTypeField => {
  if (!isForm(entry) || !entry.calls(":")) {
    throw new Error("object type fields must be labeled");
  }
  const nameExpr = entry.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("object type field name must be an identifier");
  }
  const typeExpr = entry.at(2);
  if (!typeExpr) {
    throw new Error("object type field missing type expression");
  }
  const type = lowerTypeExpr(typeExpr, ctx, scope);
  if (!type) {
    throw new Error("object type field missing resolved type expression");
  }
  return {
    name: nameExpr.value,
    type,
    span: toSourceSpan(entry),
  };
};

const lowerTupleTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope?: ScopeId
): HirTypeExpr => {
  const elements = form.rest.map((entry) => {
    const lowered = lowerTypeExpr(entry, ctx, scope);
    if (!lowered) {
      throw new Error("tuple type element missing resolved type expression");
    }
    return lowered;
  });
  return {
    typeKind: "tuple",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    elements,
  };
};

const lowerUnionTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope?: ScopeId
): HirTypeExpr => {
  const members = form.rest.map((entry) => {
    const lowered = lowerTypeExpr(entry, ctx, scope);
    if (!lowered) {
      throw new Error("union type member missing resolved type expression");
    }
    return lowered;
  });
  return {
    typeKind: "union",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    members,
  };
};

const resolveIdentifierValue = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): IdentifierResolution => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved !== "number") {
    return {
      kind: "symbol",
      name,
      symbol: resolveIntrinsicSymbol(name, ctx),
    };
  }

  const overloadSetId = ctx.overloadBySymbol.get(resolved);
  if (typeof overloadSetId === "number") {
    return { kind: "overload-set", name, set: overloadSetId };
  }

  return { kind: "symbol", name, symbol: resolved };
};

const resolveSymbol = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved === "number") {
    return resolved;
  }

  return resolveIntrinsicSymbol(name, ctx);
};

const resolveTypeSymbol = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(resolved);
  if (record.kind === "type" || record.kind === "type-parameter") {
    return resolved;
  }
  return undefined;
};

const resolveIntrinsicSymbol = (name: string, ctx: LowerContext): SymbolId => {
  let intrinsic = ctx.intrinsicSymbols.get(name);
  if (typeof intrinsic === "number") {
    return intrinsic;
  }

  intrinsic = ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.moduleNodeId,
    metadata: { intrinsic: true },
  });
  ctx.intrinsicSymbols.set(name, intrinsic);
  return intrinsic;
};
