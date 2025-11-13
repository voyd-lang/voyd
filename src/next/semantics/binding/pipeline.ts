import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type Syntax,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../parser/index.js";
import type { SymbolRecord, SymbolTable } from "../binder/index.js";
import type {
  Diagnostic,
  NodeId,
  ScopeId,
  SourceSpan,
  SymbolId,
  OverloadSetId,
} from "../ids.js";
import type { HirVisibility } from "../hir/index.js";
import { isIdentifierWithValue, toSourceSpan } from "../utils.js";

export interface BindingInputs {
  moduleForm: Form;
  symbolTable: SymbolTable;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  functions: BoundFunction[];
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
}

export interface BoundFunction {
  name: string;
  form: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  scope: ScopeId;
  params: BoundParameter[];
  returnTypeExpr?: Expr;
  body: Expr;
  overloadSetId?: OverloadSetId;
}

export interface BoundOverloadSet {
  id: OverloadSetId;
  name: string;
  scope: ScopeId;
  functions: readonly BoundFunction[];
}

export interface BoundParameter {
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

interface OverloadBucket {
  scope: ScopeId;
  name: string;
  functions: BoundFunction[];
  signatureIndex: Map<string, BoundFunction>;
  nonFunctionConflictReported: boolean;
}

interface BindingContext extends BindingResult {
  overloadBuckets: Map<string, OverloadBucket>;
  syntaxByNode: Map<NodeId, Syntax>;
}

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
}: BindingInputs): BindingResult => {
  const bindingContext: BindingContext = {
    symbolTable,
    scopeByNode: new Map([[moduleForm.syntaxId, symbolTable.rootScope]]),
    functions: [],
    overloads: new Map(),
    overloadBySymbol: new Map(),
    diagnostics: [],
    overloadBuckets: new Map(),
    syntaxByNode: new Map([[moduleForm.syntaxId, moduleForm]]),
  };

  bindModule(moduleForm, bindingContext);
  finalizeOverloadSets(bindingContext);

  return bindingContext;
};

const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
  const tracker = new BinderScopeTracker(ctx.symbolTable);
  const entries = moduleForm.rest;

  for (const entry of entries) {
    if (!isForm(entry)) continue;
    const parsed = parseFunctionDecl(entry);
    if (!parsed) {
      throw new Error(
        "unsupported top-level form; expected a function declaration"
      );
    }
    bindFunctionDecl(parsed, ctx, tracker);
  }

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

class BinderScopeTracker {
  private readonly stack: [ScopeId, ...ScopeId[]];
  constructor(private readonly symbolTable: SymbolTable) {
    this.stack = [symbolTable.rootScope];
  }

  current() {
    return this.stack.at(-1)!;
  }

  depth() {
    return this.stack.length;
  }

  enterScope<T>(scope: ScopeId, runInScope: () => T): T {
    this.push(scope);
    try {
      return runInScope();
    } finally {
      this.pop();
    }
  }

  private push(scope: ScopeId) {
    this.symbolTable.enterScope(scope);
    this.stack.push(scope);
  }

  private pop() {
    if (this.stack.length <= 1) {
      throw new Error("attempted to exit the root scope");
    }
    this.stack.pop();
    this.symbolTable.exitScope();
  }
}

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

  const signatureForm = ensureForm(
    signatureExpr,
    "fn signature must be a form"
  );
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
  const declarationScope = tracker.current();
  rememberSyntax(decl.form, ctx);
  const fnSymbol = ctx.symbolTable.declare({
    name: decl.signature.name.value,
    kind: "value",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "function" },
  });

  const fnScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, fnScope);

  const boundParams: BoundParameter[] = [];

  tracker.enterScope(fnScope, () => {
    for (const param of decl.signature.params) {
      const paramSymbol = ctx.symbolTable.declare({
        name: param.name,
        kind: "parameter",
        declaredAt: param.ast.syntaxId,
      });
      rememberSyntax(param.ast, ctx);
      boundParams.push({
        name: param.name,
        symbol: paramSymbol,
        ast: param.ast,
        typeExpr: param.typeExpr,
      });
    }

    bindExpr(decl.body, ctx, tracker);
  });

  ctx.functions.push({
    name: decl.signature.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol: fnSymbol,
    scope: fnScope,
    params: boundParams,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
  });
  recordFunctionOverload(ctx.functions.at(-1)!, declarationScope, ctx);
};

const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("block")) {
    bindBlock(expr, ctx, tracker);
    return;
  }

  if (expr.calls("if")) {
    bindIf(expr, ctx, tracker);
    return;
  }

  if (expr.calls("while")) {
    bindWhile(expr, ctx, tracker);
    return;
  }

  if (expr.calls("var") || expr.calls("let")) {
    bindVar(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindExpr(child, ctx, tracker);
  }
};

const bindBlock = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.enterScope(scope, () => {
    for (const child of form.rest) {
      bindExpr(child, ctx, tracker);
    }
  });
};

const bindIf = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
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

const bindWhile = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  bindExpr(form.at(1), ctx, tracker);
  bindExpr(form.at(2), ctx, tracker);
};

const bindVar = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const assignment = ensureForm(
    form.at(1),
    "var statement expects an assignment"
  );
  if (!assignment.calls("=")) {
    throw new Error("var statement must be an assignment form");
  }

  const patternExpr = assignment.at(1);
  const initializer = assignment.at(2);
  declarePatternBindings(patternExpr, ctx, tracker.current());
  bindExpr(initializer, ctx, tracker);
};

const declarePatternBindings = (
  pattern: Expr | undefined,
  ctx: BindingContext,
  scope: ScopeId
): void => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_") {
      return;
    }
    rememberSyntax(pattern, ctx);
    reportOverloadNameCollision(pattern.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: pattern.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
    });
    return;
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    pattern.rest.forEach((entry) => declarePatternBindings(entry, ctx, scope));
    return;
  }

  throw new Error("unsupported pattern form in declaration");
};

const rememberSyntax = (
  syntax: Syntax | undefined,
  ctx: Pick<BindingContext, "syntaxByNode">
): void => {
  if (!syntax) {
    return;
  }
  ctx.syntaxByNode.set(syntax.syntaxId, syntax);
};

const spanForNode = (nodeId: NodeId, ctx: BindingContext): SourceSpan =>
  toSourceSpan(ctx.syntaxByNode.get(nodeId));

const makeOverloadBucketKey = (scope: ScopeId, name: string): string =>
  `${scope}:${name}`;

const recordFunctionOverload = (
  fn: BoundFunction,
  declarationScope: ScopeId,
  ctx: BindingContext
): void => {
  const key = makeOverloadBucketKey(declarationScope, fn.name);
  let bucket = ctx.overloadBuckets.get(key);
  if (!bucket) {
    bucket = {
      scope: declarationScope,
      name: fn.name,
      functions: [],
      signatureIndex: new Map(),
      nonFunctionConflictReported: false,
    };
    ctx.overloadBuckets.set(key, bucket);
  }

  const signature = createOverloadSignature(fn);
  const duplicate = bucket.signatureIndex.get(signature.key);
  if (duplicate) {
    ctx.diagnostics.push({
      code: "binding.overload.duplicate",
      message: `function ${fn.name} already defines overload ${signature.label}`,
      severity: "error",
      span: toSourceSpan(fn.form),
      related: [
        {
          code: "binding.overload.previous",
          message: "previous overload declared here",
          severity: "note",
          span: toSourceSpan(duplicate.form),
        },
      ],
    });
  } else {
    bucket.signatureIndex.set(signature.key, fn);
  }

  bucket.functions.push(fn);

  const conflict = findNonFunctionDeclaration(
    fn.name,
    declarationScope,
    fn.symbol,
    ctx
  );
  if (conflict && !bucket.nonFunctionConflictReported) {
    ctx.diagnostics.push({
      code: "binding.overload.name-conflict",
      message: `cannot overload ${fn.name}; ${conflict.kind} with the same name already exists`,
      severity: "error",
      span: toSourceSpan(fn.form),
      related: [
        {
          code: "binding.overload.conflict",
          message: "conflicting declaration here",
          severity: "note",
          span: spanForNode(conflict.declaredAt, ctx),
        },
      ],
    });
    bucket.nonFunctionConflictReported = true;
  }

  if (bucket.functions.length > 1) {
    ensureOverloadParameterAnnotations(bucket, ctx);
  }
};

const createOverloadSignature = (
  fn: BoundFunction
): { key: string; label: string } => {
  const paramAnnotations = fn.params.map((param) =>
    formatTypeAnnotation(param.typeExpr)
  );
  const paramLabels = fn.params.map(
    (param, index) => `${param.name}: ${paramAnnotations[index]}`
  );
  const returnAnnotation = formatTypeAnnotation(fn.returnTypeExpr);
  return {
    key: `${fn.params.length}|${paramAnnotations.join(",")}`,
    label: `${fn.name}(${paramLabels.join(", ")}) -> ${returnAnnotation}`,
  };
};

const ensureOverloadParameterAnnotations = (
  bucket: OverloadBucket,
  ctx: BindingContext
): void => {
  const missingAnnotationSymbols = new Set<number>();
  bucket.functions.forEach((fn) => {
    fn.params.forEach((param) => {
      if (param.typeExpr) {
        return;
      }
      if (missingAnnotationSymbols.has(param.symbol)) {
        return;
      }
      const related = bucket.functions.find((candidate) => candidate !== fn);
      ctx.diagnostics.push({
        code: "binding.overload.annotation-required",
        message: `parameter ${param.name} in overloaded function ${fn.name} must declare a type`,
        severity: "error",
        span: toSourceSpan(param.ast),
        related: related
          ? [
              {
                code: "binding.overload.annotation-context",
                message: "conflicting overload declared here",
                severity: "note",
                span: toSourceSpan(related.form),
              },
            ]
          : undefined,
      });
      missingAnnotationSymbols.add(param.symbol);
    });
  });
};

const formatTypeAnnotation = (expr?: Expr): string => {
  if (!expr) {
    return "<inferred>";
  }
  if (isIdentifierAtom(expr)) {
    return expr.value;
  }
  if (isIntAtom(expr) || isFloatAtom(expr)) {
    return expr.value;
  }
  if (isStringAtom(expr)) {
    return JSON.stringify(expr.value);
  }
  if (isBoolAtom(expr)) {
    return String(expr.value);
  }
  if (isForm(expr)) {
    return `(${expr
      .toArray()
      .map((entry) => formatTypeAnnotation(entry))
      .join(" ")})`;
  }
  return "<expr>";
};

const finalizeOverloadSets = (ctx: BindingContext): void => {
  let nextOverloadSetId = 0;
  for (const bucket of ctx.overloadBuckets.values()) {
    if (bucket.functions.length < 2) {
      continue;
    }
    const id = nextOverloadSetId++;
    const functions = [...bucket.functions];
    functions.forEach((fn) => {
      fn.overloadSetId = id;
      ctx.overloadBySymbol.set(fn.symbol, id);
    });
    ctx.overloads.set(id, {
      id,
      name: bucket.name,
      scope: bucket.scope,
      functions,
    });
  }
};

const findNonFunctionDeclaration = (
  name: string,
  scope: ScopeId,
  skipSymbol: SymbolId,
  ctx: BindingContext
): SymbolRecord | undefined => {
  for (const symbolId of ctx.symbolTable.symbolsInScope(scope)) {
    if (symbolId === skipSymbol) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(symbolId);
    if (record.name !== name) {
      continue;
    }
    const metadata = (record.metadata ?? {}) as { entity?: string };
    if (metadata.entity === "function") {
      continue;
    }
    return record;
  }
  return undefined;
};

const reportOverloadNameCollision = (
  name: string,
  scope: ScopeId,
  syntax: Syntax,
  ctx: BindingContext
): void => {
  const bucket = ctx.overloadBuckets.get(makeOverloadBucketKey(scope, name));
  if (
    !bucket ||
    bucket.functions.length === 0 ||
    bucket.nonFunctionConflictReported
  ) {
    return;
  }
  ctx.diagnostics.push({
    code: "binding.overload.name-conflict",
    message: `cannot declare ${name}; overloads with this name already exist in the current scope`,
    severity: "error",
    span: toSourceSpan(syntax),
    related: [
      {
        code: "binding.overload.conflict",
        message: "conflicting overload declared here",
        severity: "note",
        span: toSourceSpan(bucket.functions[0]!.form),
      },
    ],
  });
  bucket.nonFunctionConflictReported = true;
};

const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
