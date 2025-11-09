import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../../parser/index.js";
import type { SymbolTable } from "../binder/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";
import type { HirVisibility } from "../hir/index.js";
import { isIdentifierWithValue } from "../utils.js";

export interface BindingInputs {
  moduleForm: Form;
  symbolTable: SymbolTable;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  functions: BoundFunction[];
}

export interface BoundFunction {
  form: Form;
  visibility: HirVisibility;
  symbol: SymbolId;
  scope: ScopeId;
  params: BoundParameter[];
  returnTypeExpr?: Expr;
  body: Expr;
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

interface BinderScopeTracker {
  current(): ScopeId;
  push(scope: ScopeId): void;
  pop(): void;
  depth(): number;
}

interface BindingContext extends BindingResult {}

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
}: BindingInputs): BindingResult => {
  const bindingContext: BindingContext = {
    symbolTable,
    scopeByNode: new Map([[moduleForm.syntaxId, symbolTable.rootScope]]),
    functions: [],
  };

  bindModule(moduleForm, bindingContext);

  return bindingContext;
};

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

const ensureForm = (expr: Expr, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
