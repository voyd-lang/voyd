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
import { expectLabeledExpr, parseIfBranches } from "../utils.js";
import {
  parseFunctionDecl,
  parseObjectDecl,
  parseTypeAliasDecl,
  parseImplDecl,
  parseTraitDecl,
  type ParsedFunctionDecl,
  type ParsedObjectDecl,
  type ParsedTypeAliasDecl,
  type ParsedImplDecl,
  type ParsedTraitDecl,
  type ParsedTraitMethod,
} from "./parsing.js";
import { rememberSyntax } from "./context.js";
import {
  recordFunctionOverload,
  reportOverloadNameCollision,
} from "./overloads.js";
import type { BindingContext } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type {
  ObjectFieldDecl,
  ParameterDeclInput,
  TypeParameterDecl,
  TraitMethodDeclInput,
  TraitMethodDecl,
} from "../decls.js";

export const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
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
      bindTypeAlias(typeDecl, ctx, tracker);
      continue;
    }

    const traitDecl = parseTraitDecl(entry);
    if (traitDecl) {
      bindTraitDecl(traitDecl, ctx, tracker);
      continue;
    }

    const implDecl = parseImplDecl(entry);
    if (implDecl) {
      bindImplDecl(implDecl, ctx, tracker);
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

type BindFunctionOptions = {
  declarationScope?: ScopeId;
  scopeParent?: ScopeId;
  metadata?: Record<string, unknown>;
  moduleIndex?: number;
  selfTypeExpr?: Expr;
};

const bindFunctionDecl = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const declarationScope = options.declarationScope ?? tracker.current();
  rememberSyntax(decl.form, ctx);
  const fnSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "function", ...options.metadata },
    },
    declarationScope
  );

  const fnScope = ctx.symbolTable.createScope({
    parent: options.scopeParent ?? tracker.current(),
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, fnScope);

  let typeParameters: TypeParameterDecl[] = [];
  let boundParams: ParameterDeclInput[] = [];
  tracker.enterScope(fnScope, () => {
    typeParameters = bindFunctionTypeParameters(decl, ctx);
    boundParams = bindFunctionParameters(decl, ctx, tracker, options);
  });

  const fnDecl = ctx.decls.registerFunction({
    name: decl.signature.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol: fnSymbol,
    scope: fnScope,
    params: boundParams,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
    moduleIndex: options.moduleIndex ?? ctx.nextModuleIndex++,
    implId: undefined,
  });

  recordFunctionOverload(fnDecl, declarationScope, ctx);
  return fnDecl;
};

const bindFunctionTypeParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext
): TypeParameterDecl[] =>
  bindTypeParameters(decl.signature.typeParameters, ctx);

const bindFunctionParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const boundParams: ParameterDeclInput[] = [];
  decl.signature.params.forEach((param, index) => {
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
      typeExpr:
        param.typeExpr ??
        (options.selfTypeExpr && index === 0 && param.name === "self"
          ? options.selfTypeExpr
          : undefined),
    });
  });

  bindExpr(decl.body, ctx, tracker);

  return boundParams;
};

const bindTypeAlias = (
  decl: ParsedTypeAliasDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
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

  const aliasScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, aliasScope);

  const typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(aliasScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });
  });

  ctx.decls.registerTypeAlias({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    target: decl.target,
    typeParameters,
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

  const typeParameters: TypeParameterDecl[] = [];
  const fields: ObjectFieldDecl[] = [];
  tracker.enterScope(objectScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });

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
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindTraitDecl = (
  decl: ParsedTraitDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "trait",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "trait" },
  });

  const traitScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "trait",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, traitScope);
  ctx.scopeByNode.set(decl.body.syntaxId, traitScope);

  let typeParameters: TypeParameterDecl[] = [];
  const methods: TraitMethodDeclInput[] = [];

  tracker.enterScope(traitScope, () => {
    typeParameters = bindTypeParameters(decl.typeParameters, ctx);

    decl.methods.forEach((method) => {
      methods.push(
        bindTraitMethod({
          decl: method,
          ctx,
          tracker,
          traitScope,
          traitSymbol: symbol,
        })
      );
    });
  });

  ctx.decls.registerTrait({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    typeParameters,
    methods,
    scope: traitScope,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindTraitMethod = ({
  decl,
  ctx,
  tracker,
  traitScope,
  traitSymbol,
}: {
  decl: ParsedTraitMethod;
  ctx: BindingContext;
  tracker: BinderScopeTracker;
  traitScope: ScopeId;
  traitSymbol: SymbolId;
}): TraitMethodDeclInput => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.body, ctx);

  const methodSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "trait-method", trait: traitSymbol },
    },
    traitScope
  );

  const methodScope = ctx.symbolTable.createScope({
    parent: traitScope,
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, methodScope);

  let typeParameters: TypeParameterDecl[] = [];
  let params: ParameterDeclInput[] = [];
  tracker.enterScope(methodScope, () => {
    typeParameters = bindTypeParameters(decl.signature.typeParameters, ctx);
    params = bindTraitMethodParameters(decl, ctx);
    bindExpr(decl.body, ctx, tracker);
  });

  return {
    name: decl.signature.name.value,
    form: decl.form,
    symbol: methodSymbol,
    scope: methodScope,
    nameAst: decl.signature.name,
    params,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    defaultBody: decl.body,
  };
};

const bindTraitMethodParameters = (
  decl: ParsedTraitMethod,
  ctx: BindingContext
): ParameterDeclInput[] =>
  decl.signature.params.map((param) => {
    const paramSymbol = ctx.symbolTable.declare({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
    });
    rememberSyntax(param.ast, ctx);
    rememberSyntax(param.typeExpr as Syntax, ctx);
    return {
      name: param.name,
      label: param.label,
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr: param.typeExpr,
    };
  });

const resolveTraitDecl = (
  traitExpr: Expr,
  ctx: BindingContext,
  scope: ScopeId
) => {
  if (!isIdentifierAtom(traitExpr)) {
    return undefined;
  }
  const traitSymbol = ctx.symbolTable.resolve(traitExpr.value, scope);
  if (typeof traitSymbol !== "number") {
    return undefined;
  }
  return ctx.decls.getTrait(traitSymbol);
};

const makeParsedFunctionFromTraitMethod = (
  method: TraitMethodDecl
): ParsedFunctionDecl => {
  const nameAst = method.nameAst;
  if (!nameAst) {
    throw new Error("trait method missing name identifier");
  }

  const form =
    method.form ??
    (isForm(method.defaultBody) ? method.defaultBody : undefined);
  if (!form) {
    throw new Error("trait method default implementation missing form");
  }

  const signatureParams = method.params.map((param) => {
    if (!param.ast) {
      throw new Error("trait method parameter missing syntax");
    }
    return {
      name: param.name,
      label: param.label,
      ast: param.ast,
      typeExpr: param.typeExpr,
    };
  });

  return {
    form,
    visibility: "module",
    signature: {
      name: nameAst,
      typeParameters:
        method.typeParameters
          ?.map((param) => param.ast)
          .filter((entry): entry is IdentifierAtom => Boolean(entry)) ?? [],
      params: signatureParams,
      returnType: method.returnTypeExpr,
    },
    body: method.defaultBody ?? form,
  };
};

const bindImplDecl = (
  decl: ParsedImplDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.target as Syntax, ctx);
  rememberSyntax(decl.trait as Syntax, ctx);
  rememberSyntax(decl.body, ctx);

  const implName = isIdentifierAtom(decl.target)
    ? `${decl.target.value}::impl`
    : `impl#${decl.form.syntaxId}`;

  const implSymbol = ctx.symbolTable.declare(
    {
      name: implName,
      kind: "impl",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "impl" },
    },
    tracker.current()
  );

  const implScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "impl",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, implScope);
  ctx.scopeByNode.set(decl.body.syntaxId, implScope);

  const typeParameters: TypeParameterDecl[] = [];
  const methods: ReturnType<typeof bindFunctionDecl>[] = [];
  tracker.enterScope(implScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });

    decl.body.rest.forEach((entry) => {
      if (!isForm(entry)) {
        return;
      }
      const parsedFn = parseFunctionDecl(entry);
      if (!parsedFn) {
        throw new Error("impl body supports only function declarations");
      }
      const method = bindFunctionDecl(parsedFn, ctx, tracker, {
        declarationScope: ctx.symbolTable.rootScope,
        scopeParent: implScope,
        metadata: { entity: "function", impl: implSymbol },
        selfTypeExpr: decl.target,
      });
      methods.push(method);
    });

    if (decl.trait) {
      const traitDecl = resolveTraitDecl(decl.trait, ctx, tracker.current());
      if (traitDecl) {
        const methodNames = new Set(
          methods.map((method) => ctx.symbolTable.getSymbol(method.symbol).name)
        );
        traitDecl.methods.forEach((traitMethod) => {
          if (!traitMethod.defaultBody) {
            return;
          }
          const name = ctx.symbolTable.getSymbol(traitMethod.symbol).name;
          if (methodNames.has(name)) {
            return;
          }
          const parsed = makeParsedFunctionFromTraitMethod(traitMethod);
          const method = bindFunctionDecl(parsed, ctx, tracker, {
            declarationScope: ctx.symbolTable.rootScope,
            scopeParent: implScope,
            metadata: { entity: "function", impl: implSymbol },
            selfTypeExpr: decl.target,
          });
          methods.push(method);
        });
      }
    }
  });

  const implDecl = ctx.decls.registerImpl({
    form: decl.form,
    visibility: decl.visibility,
    symbol: implSymbol,
    target: decl.target,
    trait: decl.trait,
    typeParameters,
    methods,
    scope: implScope,
    moduleIndex: ctx.nextModuleIndex++,
  });

  methods.forEach((method) => {
    method.implId = implDecl.id;
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

  if (expr.calls("match")) {
    bindMatch(expr, ctx, tracker);
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

const bindMatch = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const operandExpr = form.at(1);
  const potentialBinder = form.at(2);
  const hasBinder = isIdentifierAtom(potentialBinder);
  const caseStartIndex = hasBinder ? 3 : 2;

  const matchScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, matchScope);

  tracker.enterScope(matchScope, () => {
    bindExpr(operandExpr, ctx, tracker);

    if (hasBinder) {
      rememberSyntax(potentialBinder as Syntax, ctx);
      reportOverloadNameCollision(
        potentialBinder.value,
        matchScope,
        potentialBinder,
        ctx
      );
      ctx.symbolTable.declare({
        name: potentialBinder.value,
        kind: "value",
        declaredAt: potentialBinder.syntaxId,
      });
    }

    for (let index = caseStartIndex; index < form.length; index += 1) {
      const arm = form.at(index);
      if (!isForm(arm) || !arm.calls(":")) {
        throw new Error("match cases must be labeled with ':'");
      }

      const caseScope = ctx.symbolTable.createScope({
        parent: matchScope,
        kind: "block",
        owner: arm.syntaxId,
      });
      ctx.scopeByNode.set(arm.syntaxId, caseScope);

      tracker.enterScope(caseScope, () => {
        const valueExpr = arm.at(2);
        bindExpr(valueExpr, ctx, tracker);
      });
    }
  });
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

const bindTypeParameters = (
  params: readonly IdentifierAtom[],
  ctx: BindingContext
): TypeParameterDecl[] =>
  params.map((param) => {
    rememberSyntax(param, ctx);
    const paramSymbol = ctx.symbolTable.declare({
      name: param.value,
      kind: "type-parameter",
      declaredAt: param.syntaxId,
    });
    return {
      name: param.value,
      symbol: paramSymbol,
      ast: param,
    };
  });

const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
