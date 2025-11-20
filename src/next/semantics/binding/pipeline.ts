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
import {
  expectLabeledExpr,
  isIdentifierWithValue,
  parseIfBranches,
  toSourceSpan,
} from "../utils.js";
import {
  DeclTable,
  type FunctionDeclInput,
  type ParameterDeclInput,
  type FunctionDecl,
  type ParameterDecl,
  type TypeAliasDecl,
  type ObjectDecl,
  type ObjectFieldDecl,
} from "../decls.js";

export interface BindingInputs {
  moduleForm: Form;
  symbolTable: SymbolTable;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  functions: readonly BoundFunction[];
  typeAliases: readonly BoundTypeAlias[];
  objects: readonly BoundObject[];
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
}

export type BoundFunction = FunctionDecl;
export type BoundTypeAlias = TypeAliasDecl;
export type BoundParameter = ParameterDecl;
export type BoundObject = ObjectDecl;

export interface BoundOverloadSet {
  id: OverloadSetId;
  name: string;
  scope: ScopeId;
  functions: readonly BoundFunction[];
}

interface ParsedFunctionDecl {
  form: Form;
  visibility: HirVisibility;
  signature: ParsedFunctionSignature;
  body: Expr;
}

interface ParsedTypeAliasDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  target: Expr;
}

interface ParsedObjectDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  base?: IdentifierAtom;
  body: Form;
  fields: readonly ParsedObjectField[];
}

interface ParsedObjectField {
  name: IdentifierAtom;
  typeExpr: Expr;
  ast: Syntax;
}

interface ParsedFunctionSignature {
  name: IdentifierAtom;
  params: SignatureParam[];
  returnType?: Expr;
}

interface SignatureParam {
  name: string;
  label?: string;
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

interface BindingContext {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
  overloadBuckets: Map<string, OverloadBucket>;
  syntaxByNode: Map<NodeId, Syntax>;
  nextModuleIndex: number;
}

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
}: BindingInputs): BindingResult => {
  const decls = new DeclTable();
  const bindingContext: BindingContext = {
    symbolTable,
    scopeByNode: new Map([[moduleForm.syntaxId, symbolTable.rootScope]]),
    decls,
    overloads: new Map(),
    overloadBySymbol: new Map(),
    diagnostics: [],
    overloadBuckets: new Map(),
    syntaxByNode: new Map([[moduleForm.syntaxId, moduleForm]]),
    nextModuleIndex: 0,
  };

  bindModule(moduleForm, bindingContext);
  finalizeOverloadSets(bindingContext);

  return {
    symbolTable: bindingContext.symbolTable,
    scopeByNode: bindingContext.scopeByNode,
    decls: bindingContext.decls,
    functions: bindingContext.decls.functions,
    typeAliases: bindingContext.decls.typeAliases,
    objects: bindingContext.decls.objects,
    overloads: bindingContext.overloads,
    overloadBySymbol: bindingContext.overloadBySymbol,
    diagnostics: bindingContext.diagnostics,
  };
};

const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
  const tracker = new BinderScopeTracker(ctx.symbolTable);
  const entries = moduleForm.rest;

  for (const entry of entries) {
    if (!isForm(entry)) continue;
    const parsed = parseFunctionDecl(entry);
    if (parsed) {
      bindFunctionDecl(parsed, ctx, tracker);
      continue;
    }

    const objectDecl = parseObjectDecl(entry);
    if (objectDecl) {
      bindObjectDecl(objectDecl, ctx, tracker);
      continue;
    }

    const typeDecl = parseTypeAliasDecl(entry);
    if (typeDecl) {
      bindTypeAlias(typeDecl, ctx);
      continue;
    }

    throw new Error(
      "unsupported top-level form; expected a function or type declaration"
    );
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

const parseTypeAliasDecl = (form: Form): ParsedTypeAliasDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "type")) {
    return null;
  }

  const assignment = form.at(index + 1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    throw new Error("type declaration expects an assignment");
  }

  const nameExpr = assignment.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("type name must be an identifier");
  }

  const target = assignment.at(2);
  if (!target) {
    throw new Error("type declaration missing target expression");
  }

  return { form, visibility, name: nameExpr, target };
};

const parseObjectDecl = (form: Form): ParsedObjectDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "obj")) {
    return null;
  }

  const head = form.at(index + 1);
  const body = form.at(index + 2);
  if (!body || !isForm(body) || !body.callsInternal("object_literal")) {
    throw new Error("obj declaration requires a field list");
  }

  const { name, base } = parseObjectHead(head);
  const fields = parseObjectFields(body);

  return { form, visibility, name, base, body, fields };
};

const parseObjectHead = (
  expr: Expr | undefined
): { name: IdentifierAtom; base?: IdentifierAtom } => {
  if (!expr) {
    throw new Error("obj declaration missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr };
  }

  if (isForm(expr) && expr.calls(":")) {
    const nameExpr = expr.at(1);
    const baseExpr = expr.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("obj name must be an identifier");
    }
    if (!isIdentifierAtom(baseExpr)) {
      throw new Error("obj base must be an identifier");
    }
    return { name: nameExpr, base: baseExpr };
  }

  throw new Error("invalid obj declaration head");
};

const parseObjectFields = (body: Form): ParsedObjectField[] =>
  body.rest.map((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      throw new Error("object fields must be labeled");
    }
    const nameExpr = entry.at(1);
    const typeExpr = entry.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("object field name must be an identifier");
    }
    if (!typeExpr) {
      throw new Error("object field missing type");
    }
    return { name: nameExpr, typeExpr, ast: entry };
  });

const parseFunctionSignature = (form: Form): ParsedFunctionSignature => {
  if (form.calls("->")) {
    const head = parseFunctionHead(form.at(1));
    return {
      name: head.name,
      params: head.params.flatMap(parseParameter),
      returnType: form.at(2),
    };
  }

  const head = parseFunctionHead(form);
  return {
    name: head.name,
    params: head.params.flatMap(parseParameter),
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

const parseParameter = (expr: Expr): SignatureParam | SignatureParam[] => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls(":")) {
    return parseSingleParam(expr);
  }

  if (isForm(expr) && expr.callsInternal("object_literal")) {
    return parseLabeledParameters(expr);
  }

  throw new Error("unsupported parameter form");
};

const parseLabeledParameters = (form: Form): SignatureParam[] =>
  form.rest.map((expr) => {
    if (isForm(expr) && expr.calls(":")) {
      const param = parseSingleParam(expr);
      return {
        ...param,
        label: param.name,
      };
    }

    // // External labeled param { with val: i32 }
    if (
      isForm(expr) &&
      isIdentifierAtom(expr.first) &&
      isForm(expr.second) &&
      expr.second.calls(":")
    ) {
      const labelExpr = expr.first;
      return {
        label: labelExpr.value,
        ...parseSingleParam(expr.second),
      };
    }

    throw new Error("unsupported parameter form");
  });

const parseSingleParam = (expr: Form): SignatureParam => {
  const nameExpr = expr.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("parameter name must be an identifier");
  }
  return {
    name: nameExpr.value,
    ast: nameExpr,
    typeExpr: expr.at(2),
  };
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

  const boundParams: ParameterDeclInput[] = [];

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
        label: param.label,
        symbol: paramSymbol,
        ast: param.ast,
        typeExpr: param.typeExpr,
      });
    }

    bindExpr(decl.body, ctx, tracker);
  });

  const fnDecl: FunctionDeclInput = {
    name: decl.signature.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol: fnSymbol,
    scope: fnScope,
    params: boundParams,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
    moduleIndex: ctx.nextModuleIndex++,
  };

  const registered = ctx.decls.registerFunction(fnDecl);
  recordFunctionOverload(registered, declarationScope, ctx);
};

const bindTypeAlias = (
  decl: ParsedTypeAliasDecl,
  ctx: BindingContext
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.target as Syntax, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "type-alias" },
  });

  ctx.decls.registerTypeAlias({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    target: decl.target,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindObjectDecl = (
  decl: ParsedObjectDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.base, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "object" },
  });

  const objectScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, objectScope);

  const fields: ObjectFieldDecl[] = [];
  tracker.enterScope(objectScope, () => {
    decl.fields.forEach((field) => {
      rememberSyntax(field.ast, ctx);
      rememberSyntax(field.name, ctx);
      rememberSyntax(field.typeExpr as Syntax, ctx);

      const fieldSymbol = ctx.symbolTable.declare({
        name: field.name.value,
        kind: "value",
        declaredAt: field.ast.syntaxId,
        metadata: { entity: "field", owner: symbol },
      });

      fields.push({
        name: field.name.value,
        symbol: fieldSymbol,
        ast: field.ast,
        typeExpr: field.typeExpr,
      });
    });
  });

  ctx.decls.registerObject({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    baseTypeExpr: decl.base,
    fields,
    moduleIndex: ctx.nextModuleIndex++,
  });
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
  const { branches, defaultBranch } = parseIfBranches(form);
  branches.forEach(({ condition, value }) => {
    bindExpr(condition, ctx, tracker);
    bindExpr(value, ctx, tracker);
  });

  if (defaultBranch) {
    bindExpr(defaultBranch, ctx, tracker);
  }
};

const bindWhile = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const condition = form.at(1);
  if (!condition) {
    throw new Error("while expression missing condition");
  }

  const body = expectLabeledExpr(form.at(2), "do", "while expression");

  bindExpr(condition, ctx, tracker);
  bindExpr(body, ctx, tracker);
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

  if (isForm(pattern) && pattern.calls(":")) {
    const nameExpr = pattern.at(1);
    const typeExpr = pattern.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("typed pattern name must be an identifier");
    }
    rememberSyntax(nameExpr, ctx);
    rememberSyntax(typeExpr as Syntax, ctx);
    reportOverloadNameCollision(nameExpr.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: nameExpr.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
    });
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
  const params = fn.params.map((param) => {
    const annotation = formatTypeAnnotation(param.typeExpr);
    const displayName = formatParameterDisplayName(param);
    const labelKey = param.label ?? "";
    return {
      key: `${labelKey}:${annotation}`,
      label: `${displayName}: ${annotation}`,
    };
  });
  const returnAnnotation = formatTypeAnnotation(fn.returnTypeExpr);
  return {
    key: `${fn.params.length}|${params.map((param) => param.key).join(",")}`,
    label: `${fn.name}(${params
      .map((param) => param.label)
      .join(", ")}) -> ${returnAnnotation}`,
  };
};

const formatParameterDisplayName = (param: BoundParameter): string => {
  if (!param.label) {
    return param.name;
  }
  if (param.label === param.name) {
    return param.label;
  }
  return `${param.label} ${param.name}`;
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
    if (metadata.entity === "function" || metadata.entity === "object") {
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
