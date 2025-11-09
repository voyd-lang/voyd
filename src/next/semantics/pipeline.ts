import {
  Expr,
  Form,
  IdentifierAtom,
  Syntax,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../parser/index.js";
import { createSymbolTable, type SymbolTable } from "./binder/index.js";
import type { HirExprId, HirStmtId, NodeId, ScopeId, SourceSpan, SymbolId } from "./ids.js";
import {
  createHirBuilder,
  type HirBuilder,
  type HirCondBranch,
  type HirGraph,
  type HirParameter,
  type HirTypeExpr,
  type HirVisibility,
} from "./hir/index.js";

export interface SemanticsPipelineResult {
  symbolTable: SymbolTable;
  hir: HirGraph;
}

export const semanticsPipeline = (form: Form): SemanticsPipelineResult => {
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  const modulePath = form.location?.filePath ?? "<module>";
  const symbolTable = createSymbolTable({ rootOwner: form.syntaxId });
  const moduleSymbol = symbolTable.declare({
    name: modulePath,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const builder = createHirBuilder({
    path: modulePath,
    scope: moduleSymbol,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  const bindingContext: BindingContext = {
    symbolTable,
    scopeByNode: new Map([[form.syntaxId, symbolTable.rootScope]]),
    functions: [],
  };

  bindModule(form, bindingContext);

  const hir = lowerModule({
    builder,
    binding: bindingContext,
    moduleNodeId: form.syntaxId,
  });

  return { symbolTable, hir };
};

interface BindingContext {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  functions: BoundFunction[];
}

interface BoundFunction {
  form: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  scope: ScopeId;
  params: BoundParameter[];
  returnTypeExpr?: Expr;
  body: Expr;
}

interface BoundParameter {
  name: string;
  symbol: SymbolId;
  ast: Syntax;
  typeExpr?: Expr;
}

interface ParsedFunctionDecl {
  form: Form;
  visibility: HirVisibility;
  signature: ParsedFunctionSignature;
  body: Expr;
}

interface ParsedFunctionSignature {
  name: IdentifierAtom;
  params: SignatureParam[];
  returnType?: Expr;
}

interface SignatureParam {
  name: string;
  ast: Syntax;
  typeExpr?: Expr;
}

interface BinderScopeTracker {
  current(): ScopeId;
  push(scope: ScopeId): void;
  pop(): void;
  depth(): number;
}

const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
  const tracker = createBinderScopeTracker(ctx.symbolTable);
  const entries = moduleForm.rest;

  for (const entry of entries) {
    if (!isForm(entry)) continue;
    const parsed = parseFunctionDecl(entry);
    if (!parsed) {
      throw new Error("unsupported top-level form; expected a function declaration");
    }
    bindFunctionDecl(parsed, ctx, tracker);
  }

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

const createBinderScopeTracker = (symbolTable: SymbolTable): BinderScopeTracker => {
  const stack: ScopeId[] = [symbolTable.rootScope];

  return {
    current: () => stack.at(-1)!,
    push: (scope: ScopeId) => {
      symbolTable.enterScope(scope);
      stack.push(scope);
    },
    pop: () => {
      if (stack.length <= 1) {
        throw new Error("attempted to exit the root scope");
      }
      stack.pop();
      symbolTable.exitScope();
    },
    depth: () => stack.length,
  };
};

const parseFunctionDecl = (form: Form): ParsedFunctionDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "fn")) {
    return null;
  }

  let signatureExpr: Expr | undefined = form.at(index + 1);
  let bodyExpr: Expr | undefined = form.at(index + 2);

  if (!bodyExpr && isForm(signatureExpr) && signatureExpr.calls("=")) {
    bodyExpr = signatureExpr.at(2);
    signatureExpr = signatureExpr.at(1);
  }

  if (!signatureExpr) {
    throw new Error("fn missing signature");
  }

  if (!bodyExpr) {
    throw new Error("fn missing body expression");
  }

  const signatureForm = ensureForm(signatureExpr, "fn signature must be a form");
  const signature = parseFunctionSignature(signatureForm);

  return {
    form,
    visibility,
    signature,
    body: bodyExpr,
  };
};

const parseFunctionSignature = (form: Form): ParsedFunctionSignature => {
  if (form.calls("->")) {
    const head = parseFunctionHead(form.at(1));
    return {
      name: head.name,
      params: head.params.map(parseParameter),
      returnType: form.at(2),
    };
  }

  const head = parseFunctionHead(form);
  return {
    name: head.name,
    params: head.params.map(parseParameter),
  };
};

const parseFunctionHead = (
  expr: Expr | undefined
): { name: IdentifierAtom; params: readonly Expr[] } => {
  if (!expr) {
    throw new Error("fn missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr, params: [] };
  }

  if (isForm(expr)) {
    const nameExpr = expr.at(0);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("fn name must be an identifier");
    }
    return { name: nameExpr, params: expr.rest };
  }

  throw new Error("fn name must be an identifier");
};

const parseParameter = (expr: Expr): SignatureParam => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls(":")) {
    const nameExpr = expr.at(1);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("parameter name must be an identifier");
    }
    return {
      name: nameExpr.value,
      ast: nameExpr,
      typeExpr: expr.at(2),
    };
  }

  throw new Error("unsupported parameter form");
};

const bindFunctionDecl = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
) => {
  const fnSymbol = ctx.symbolTable.declare({
    name: decl.signature.name.value,
    kind: "value",
    declaredAt: decl.form.syntaxId,
  });

  const fnScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, fnScope);

  tracker.push(fnScope);
  const boundParams: BoundParameter[] = [];

  try {
    for (const param of decl.signature.params) {
      const paramSymbol = ctx.symbolTable.declare({
        name: param.name,
        kind: "parameter",
        declaredAt: param.ast.syntaxId,
      });
      boundParams.push({
        name: param.name,
        symbol: paramSymbol,
        ast: param.ast,
        typeExpr: param.typeExpr,
      });
    }

    bindExpr(decl.body, ctx, tracker);
  } finally {
    tracker.pop();
  }

  ctx.functions.push({
    form: decl.form,
    visibility: decl.visibility,
    symbol: fnSymbol,
    scope: fnScope,
    params: boundParams,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
  });
};

const bindExpr = (expr: Expr | undefined, ctx: BindingContext, tracker: BinderScopeTracker): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("block")) {
    bindBlock(expr, ctx, tracker);
    return;
  }

  if (expr.calls("if")) {
    bindIf(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindExpr(child, ctx, tracker);
  }
};

const bindBlock = (form: Form, ctx: BindingContext, tracker: BinderScopeTracker): void => {
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.push(scope);
  try {
    for (const child of form.rest) {
      bindExpr(child, ctx, tracker);
    }
  } finally {
    tracker.pop();
  }
};

const bindIf = (form: Form, ctx: BindingContext, tracker: BinderScopeTracker): void => {
  bindExpr(form.at(1), ctx, tracker);
  for (let i = 2; i < form.length; i += 1) {
    const branch = form.at(i);
    if (!isForm(branch) || !branch.calls(":")) {
      bindExpr(branch, ctx, tracker);
      continue;
    }
    bindExpr(branch.at(2), ctx, tracker);
  }
};

interface LowerInputs {
  builder: HirBuilder;
  binding: BindingContext;
  moduleNodeId: NodeId;
}

interface LowerScopeStack {
  current(): ScopeId;
  push(scope: ScopeId): void;
  pop(): void;
}

const lowerModule = (inputs: LowerInputs): HirGraph => {
  const intrinsicSymbols = new Map<string, SymbolId>();

  for (const fn of inputs.binding.functions) {
    lowerFunction(fn, {
      builder: inputs.builder,
      symbolTable: inputs.binding.symbolTable,
      scopeByNode: inputs.binding.scopeByNode,
      intrinsicSymbols,
      moduleNodeId: inputs.moduleNodeId,
    });
  }

  return inputs.builder.finalize();
};

interface LowerContext {
  builder: HirBuilder;
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  intrinsicSymbols: Map<string, SymbolId>;
  moduleNodeId: NodeId;
}

const lowerFunction = (fn: BoundFunction, ctx: LowerContext): void => {
  const scopes = createLowerScopeStack(fn.scope);

  const parameters: HirParameter[] = fn.params.map((param) => ({
    symbol: param.symbol,
    pattern: { kind: "identifier", symbol: param.symbol } as const,
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

const lowerExpr = (expr: Expr | undefined, ctx: LowerContext, scopes: LowerScopeStack): HirExprId => {
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
    const symbol = resolveSymbol(expr.value, scopes.current(), ctx);
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "identifier",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      symbol,
    });
  }

  if (isForm(expr)) {
    if (expr.calls("block")) {
      return lowerBlock(expr, ctx, scopes);
    }

    if (expr.calls("if")) {
      return lowerIf(expr, ctx, scopes);
    }

    return lowerCall(expr, ctx, scopes);
  }

  throw new Error(`unsupported expression node: ${expr}`);
};

const lowerBlock = (form: Form, ctx: LowerContext, scopes: LowerScopeStack): HirExprId => {
  const scopeId = ctx.scopeByNode.get(form.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const statements: HirStmtId[] = [];
  let value: HirExprId | undefined;
  const entries = form.rest;

  entries.forEach((entry, index) => {
    const exprId = lowerExpr(entry, ctx, scopes);
    if (index < entries.length - 1) {
      statements.push(
        ctx.builder.addStatement({
          kind: "expr-stmt",
          ast: (entry as Syntax).syntaxId,
          span: toSourceSpan(entry as Syntax),
          expr: exprId,
        })
      );
    } else {
      value = exprId;
    }
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

const lowerIf = (form: Form, ctx: LowerContext, scopes: LowerScopeStack): HirExprId => {
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

const lowerCall = (form: Form, ctx: LowerContext, scopes: LowerScopeStack): HirExprId => {
  const callee = form.at(0);
  if (!callee) {
    throw new Error("call expression missing callee");
  }

  const calleeId = lowerExpr(callee, ctx, scopes);
  const args = form.rest.map((arg) => lowerExpr(arg, ctx, scopes));

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    callee: calleeId,
    args,
  });
};

const lowerTypeExpr = (expr: Expr | undefined, ctx: LowerContext): HirTypeExpr | undefined => {
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

const resolveSymbol = (name: string, scope: ScopeId, ctx: LowerContext): SymbolId => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved === "number") {
    return resolved;
  }

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

const ensureForm = (expr: Expr, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};

const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string
): expr is IdentifierAtom => isIdentifierAtom(expr) && expr.value === value;

const toSourceSpan = (syntax?: Syntax): SourceSpan => {
  const location = syntax?.location;
  if (!location) {
    return { file: "<unknown>", start: 0, end: 0 };
  }
  return {
    file: location.filePath,
    start: location.startIndex,
    end: location.endIndex,
  };
};
