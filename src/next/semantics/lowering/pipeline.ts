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
  HirObjectLiteralEntry,
  HirParameter,
  HirPattern,
  HirRecordTypeField,
  HirTypeExpr,
} from "../hir/index.js";
import type {
  BoundFunction,
  BoundTypeAlias,
  BindingResult,
} from "../binding/pipeline.js";
import { isIdentifierWithValue, toSourceSpan } from "../utils.js";

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
  | { kind: "type-alias"; order: number; alias: BoundTypeAlias };

const getModuleDeclarations = (
  binding: BindingResult
): ModuleDeclaration[] => {
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

  const parameters: HirParameter[] = fn.params.map((param) => ({
    symbol: param.symbol,
    pattern: { kind: "identifier", symbol: param.symbol } as const,
    label: param.label,
    span: toSourceSpan(param.ast),
    mutable: false,
    type: lowerTypeExpr(param.typeExpr, ctx),
  }));

  const bodyId = lowerExpr(fn.body, ctx, scopes);
  const fnId = ctx.builder.addFunction({
    kind: "function",
    visibility: fn.visibility,
    symbol: fn.symbol,
    ast: fn.form.syntaxId,
    span: toSourceSpan(fn.form),
    parameters,
    returnType: lowerTypeExpr(fn.returnTypeExpr, ctx),
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

  const aliasId = ctx.builder.addItem({
    kind: "type-alias",
    symbol: alias.symbol,
    visibility: alias.visibility,
    ast: alias.form.syntaxId,
    span: toSourceSpan(alias.form),
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

const createLowerScopeStack = (initial: ScopeId): LowerScopeStack => {
  const stack: ScopeId[] = [initial];

  return {
    current: () => stack.at(-1)!,
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
  const conditionExpr = form.at(1);
  if (!conditionExpr) {
    throw new Error("if expression missing condition");
  }

  const condition = lowerExpr(conditionExpr, ctx, scopes);
  const branches: HirCondBranch[] = [];
  let defaultBranch: HirExprId | undefined;

  for (let i = 2; i < form.length; i += 1) {
    const branch = form.at(i);
    if (!isForm(branch) || !branch.calls(":")) continue;
    const label = branch.at(1);
    const valueExpr = branch.at(2);
    if (!valueExpr) continue;

    if (isIdentifierWithValue(label, "then")) {
      branches.push({
        condition,
        value: lowerExpr(valueExpr, ctx, scopes),
      });
      continue;
    }

    if (isIdentifierWithValue(label, "else")) {
      defaultBranch = lowerExpr(valueExpr, ctx, scopes);
    }
  }

  if (!branches.length) {
    throw new Error("if expression missing then branch");
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "if",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    branches,
    defaultBranch,
  });
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

const lowerCall = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const callee = form.at(0);
  if (!callee) {
    throw new Error("call expression missing callee");
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
  scopes: LowerScopeStack
): HirExprId => {
  const entries = form.rest.map((entry) =>
    lowerObjectLiteralEntry(entry, ctx, scopes)
  );
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    literalKind: "structural",
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
    isForm(potentialGenerics) && formCallsInternal(potentialGenerics, "generics");
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
  const bodyExpr = form.at(2);
  if (!conditionExpr || !bodyExpr) {
    throw new Error("while expression requires condition and body");
  }

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
  ctx: LowerContext
): HirTypeExpr | undefined => {
  if (!expr) return undefined;

  if (isIdentifierAtom(expr)) {
    return {
      typeKind: "named",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      path: [expr.value],
    };
  }

  if (isForm(expr) && isObjectLiteralForm(expr)) {
    return lowerObjectTypeExpr(expr, ctx);
  }

  throw new Error("unsupported type expression");
};

const lowerObjectTypeExpr = (
  form: Form,
  ctx: LowerContext
): HirTypeExpr => {
  const fields = form.rest.map((entry) => lowerObjectTypeField(entry, ctx));
  return {
    typeKind: "object",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    fields,
  };
};

const lowerObjectTypeField = (
  entry: Expr | undefined,
  ctx: LowerContext
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
  const type = lowerTypeExpr(typeExpr, ctx);
  if (!type) {
    throw new Error("object type field missing resolved type expression");
  }
  return {
    name: nameExpr.value,
    type,
    span: toSourceSpan(entry),
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
