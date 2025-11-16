import {
  type Expr,
  type Form,
  type Syntax,
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
  HirParameter,
  HirPattern,
  HirTypeExpr,
} from "../hir/index.js";
import type { BoundFunction, BindingResult } from "../binding/pipeline.js";
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

export const runLoweringPipeline = (inputs: LowerInputs): HirGraph => {
  const intrinsicSymbols = new Map<string, SymbolId>();

  for (const fn of inputs.binding.functions) {
    lowerFunction(fn, {
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

const lowerCall = (
  form: Form,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  const callee = form.at(0);
  if (!callee) {
    throw new Error("call expression missing callee");
  }

  const calleeId = lowerExpr(callee, ctx, scopes);
  const args = form.rest.map((arg) => {
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
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: calleeId,
    args,
  });
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

  throw new Error("unsupported type expression");
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
