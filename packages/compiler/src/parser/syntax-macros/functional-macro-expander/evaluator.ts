import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../ast/index.js";
import { Syntax } from "../../ast/syntax.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseImplDecl,
  parseModuleLetDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "../../surface/declarations.js";
import {
  parseSurfaceBindingStatement,
  parseSurfaceHandlerClause,
  parseSurfaceLambdaExpression,
  parseSurfaceMatchExpression,
  parseSurfaceTryExpression,
  type SurfaceMatchPattern,
  type SurfacePattern,
} from "../../surface/index.js";
import { createBuiltins, fnsToSkipArgEval } from "./builtins.js";
import {
  cloneExpr,
  cloneMacroEvalResult,
  expectExpr,
  recreateForm,
} from "./helpers.js";
import { MacroScope } from "./scope.js";
import type {
  EvalOpts,
  MacroDefinition,
  MacroEvalResult,
  MacroLambdaValue,
} from "./types.js";
import { isMacroLambdaValue } from "./types.js";

type ExpandMacroCallOptions = {
  preserveExplicitLocationMarkers?: boolean;
  resolveArgumentBindings?: boolean;
};

export function evalMacroExpr(
  expr: Expr,
  scope: MacroScope,
  opts: EvalOpts = {},
): MacroEvalResult {
  // `with_location` returns syntax as an opaque macro value. Nested expansion
  // must not evaluate that syntax before the outer expansion consumes it.
  if (expr.attributes?.__macroExplicitLocation === true) {
    return cloneExpr(expr);
  }

  if (isIdentifierAtom(expr)) {
    const value = scope.getVariable(expr.value)?.value;
    return value ? cloneMacroEvalResult(value) : expr;
  }

  if (!isForm(expr)) return expr;

  if (expr.calls(".")) {
    return evalMacroExpr(transformDotCall(expr), scope, opts);
  }

  if (expr.calls("block")) {
    return evalBlock(expr, scope);
  }

  return evalCall(expr, scope, opts);
}

function evalBlock(block: Form, scope: MacroScope): MacroEvalResult {
  const childScope = scope.child();
  let result: MacroEvalResult = new IdentifierAtom("nop");

  block
    .toArray()
    .slice(1)
    .forEach((expression) => {
      result = evalMacroExpr(expression, childScope);
    });

  return result;
}

function evalCall(
  form: Form,
  scope: MacroScope,
  opts: EvalOpts,
): MacroEvalResult {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    const evaluated = form
      .toArray()
      .map((expression) => expectExpr(evalMacroExpr(expression, scope, opts)));
    return recreateForm(form, evaluated);
  }

  const id = head.value;
  const macro = scope.getMacro(id);
  if (macro) {
    const expanded = expandMacroCall(form, macro, scope, {
      preserveExplicitLocationMarkers: true,
      resolveArgumentBindings: true,
    });
    return evalMacroExpr(expanded, scope, opts);
  }

  const argExprs = form.toArray().slice(1);
  const args: MacroEvalResult[] = fnsToSkipArgEval.has(id)
    ? argExprs
    : argExprs.map((expression) => evalMacroExpr(expression, scope, opts));

  const builtin = builtins[id];
  if (builtin && !opts.skipBuiltins?.has(id)) {
    return builtin({
      call: form,
      args,
      originalArgs: argExprs,
      scope,
    });
  }

  const evaluatedHead = evalMacroExpr(head, scope, opts);
  if (isMacroLambdaValue(evaluatedHead)) {
    return callLambda(
      evaluatedHead,
      args.filter((value): value is Expr => value instanceof Syntax),
    );
  }

  const normalizedArgs = args.map((arg) => expectExpr(arg));
  return recreateForm(form, [expectExpr(evaluatedHead), ...normalizedArgs]);
}

export function expandMacroCall(
  call: Form,
  macro: MacroDefinition,
  scope: MacroScope,
  options: ExpandMacroCallOptions = {},
): Expr {
  const invocationScope = scope.invocationScope({
    definitionScope: macro.scope,
    macroKey: macro.id.value,
  });
  const args = call.rest.map((argument) => {
    if (options.resolveArgumentBindings && isIdentifierAtom(argument)) {
      const binding = scope.getVariable(argument.value)?.value;
      if (binding instanceof Syntax) {
        return cloneExpr(binding);
      }
    }
    return cloneExpr(argument);
  });
  const preservedLocations = collectSyntaxLocationKeys(args);
  const bodyArguments = new Form({
    location: call.location?.clone(),
    elements: args.map(cloneExpr),
  });

  invocationScope.defineVariable({
    name: new IdentifierAtom("body"),
    value: bodyArguments,
    mutable: false,
  });

  macro.parameters.forEach((param, index) => {
    const supplied = args.at(index);
    if (!supplied) {
      throw new Error(
        `Macro ${macro.name.value} expected ${macro.parameters.length} arguments, received ${index}`,
      );
    }
    invocationScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(supplied),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  macro.body.forEach((expression) => {
    const templateExpression = cloneExpr(expression);
    markMacroTemplateIdentifiers({
      syntax: templateExpression,
      definitionModuleId:
        macro.moduleId ??
        macro.declarationName.location?.filePath ??
        "<macro-definition>",
      expansionId: invocationScope.currentExpansionId(),
    });
    result = evalMacroExpr(templateExpression, invocationScope);
  });

  const normalized = expectExpr(result, "macro expansion result");
  assertSymbolReferencesAreReferenceOnly(normalized);
  if (call.location) {
    rebaseGeneratedSyntax({
      syntax: normalized,
      invocationLocation: call.location,
      preservedLocations,
      preserveExplicitLocationMarkers:
        options.preserveExplicitLocationMarkers === true,
    });
  }
  return normalized;
}

const rebaseGeneratedSyntax = ({
  syntax,
  invocationLocation,
  preservedLocations,
  preserveExplicitLocationMarkers,
}: {
  syntax: Syntax;
  invocationLocation: NonNullable<Syntax["location"]>;
  preservedLocations: ReadonlySet<string>;
  preserveExplicitLocationMarkers: boolean;
}): void => {
  const key = syntaxLocationKey(syntax);
  const hasExplicitLocation =
    syntax.attributes?.__macroExplicitLocation === true;
  if (
    hasExplicitLocation &&
    syntax.attributes &&
    !preserveExplicitLocationMarkers
  ) {
    delete syntax.attributes.__macroExplicitLocation;
    if (Object.keys(syntax.attributes).length === 0) {
      syntax.attributes = undefined;
    }
  }
  if (!hasExplicitLocation && (!key || !preservedLocations.has(key))) {
    syntax.macroProvenance = {
      invocation: invocationLocation.clone(),
      definition:
        syntax.macroProvenance?.definition?.clone() ?? syntax.location?.clone(),
    };
    syntax.setLocation(invocationLocation.clone());
  }
  if (isForm(syntax)) {
    syntax.toArray().forEach((entry) =>
      rebaseGeneratedSyntax({
        syntax: entry,
        invocationLocation,
        preservedLocations,
        preserveExplicitLocationMarkers,
      }),
    );
  }
};

const markMacroTemplateIdentifiers = ({
  syntax,
  definitionModuleId,
  expansionId,
}: {
  syntax: Syntax;
  definitionModuleId: string;
  expansionId: string;
}): void => {
  if (isIdentifierAtom(syntax) && !syntax.lexicalContext) {
    syntax.lexicalContext = {
      kind: "macro-template",
      definitionModuleId,
      expansionId,
    };
    syntax.macroProvenance = {
      definition: syntax.location?.clone(),
    };
  }
  if (isForm(syntax)) {
    syntax.toArray().forEach((entry) =>
      markMacroTemplateIdentifiers({
        syntax: entry,
        definitionModuleId,
        expansionId,
      }),
    );
  }
};

const assertSymbolReferencesAreReferenceOnly = (syntax: Syntax): void => {
  if (!isForm(syntax)) {
    return;
  }

  const first = syntax.at(0);
  const second = syntax.at(1);
  if (isIdentifierAtom(first) && first.value === "pub" && isForm(second)) {
    assertUseAliasesAreBindable(second);
    return;
  }

  const headValue = declarationHeadValue(syntax);
  if (headValue === "let" || headValue === "var") {
    assertBindingStatementIsBindable(syntax, headValue);
    return;
  }
  if (headValue === "=>") {
    const lambda = parseSurfaceLambdaExpression(syntax);
    lambda.signature.typeParameters?.forEach(assertNotSymbolReference);
    lambda.signature.normalizedParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    assertSymbolReferencesAreReferenceOnly(lambda.body);
    return;
  }
  if (headValue === "match") {
    const match = parseSurfaceMatchExpression(syntax);
    assertNotSymbolReference(match.binder);
    assertSymbolReferencesAreReferenceOnly(match.operand);
    match.arms.forEach((arm) => {
      assertMatchPatternBindingsAreBindable(arm.pattern);
      assertSymbolReferencesAreReferenceOnly(arm.value);
    });
    return;
  }
  if (headValue === "try") {
    const { body, bodyIndex } = parseSurfaceTryExpression(syntax);
    assertTryBodyBindingsAreBindable(body);
    syntax
      .toArray()
      .slice(bodyIndex + 1)
      .forEach((entry) => {
        if (!isForm(entry) || !entry.calls(":")) {
          assertTryBodyBindingsAreBindable(entry);
          return;
        }
        assertHandlerClauseBindingsAreBindable(entry);
      });
    return;
  }
  if (headValue && DECLARATION_HEADS.has(headValue)) {
    assertDeclarationBindingsAreBindable(syntax, headValue);
    return;
  }

  syntax.toArray().forEach(assertSymbolReferencesAreReferenceOnly);
};

const assertTryBodyBindingsAreBindable = (syntax: Syntax): void => {
  if (!isForm(syntax)) {
    return;
  }

  if (isQualifiedHandlerClause(syntax)) {
    assertHandlerClauseBindingsAreBindable(syntax);
    return;
  }

  syntax.toArray().forEach(assertTryBodyBindingsAreBindable);
};

const assertHandlerClauseBindingsAreBindable = (syntax: Form): void => {
  const { head, body } = parseSurfaceHandlerClause(syntax);
  head.parameters.forEach(({ syntax: parameter }) =>
    assertNotSymbolReference(parameter),
  );
  assertSymbolReferencesAreReferenceOnly(head.syntax);
  assertSymbolReferencesAreReferenceOnly(body);
};

const isQualifiedHandlerClause = (syntax: Form): boolean => {
  if (!syntax.calls(":")) {
    return false;
  }
  const head = syntax.at(1);
  return isForm(head) && head.calls("::") && isForm(head.at(2));
};

const assertBindingStatementIsBindable = (
  form: Form,
  head: "let" | "var",
): void => {
  const first = form.at(0);
  if (
    head === "let" &&
    isIdentifierAtom(first) &&
    DECLARATION_MODIFIERS.has(first.value)
  ) {
    const declaration = parseModuleLetDecl(form);
    if (!declaration) return;
    assertNotSymbolReference(declaration.name);
    assertSymbolReferencesAreReferenceOnly(declaration.initializer);
    return;
  }

  const binding = parseSurfaceBindingStatement(form);
  assertSurfacePatternBindingsAreBindable(binding.pattern);
  assertSymbolReferencesAreReferenceOnly(binding.initializer);
};

const assertSurfacePatternBindingsAreBindable = (
  pattern: SurfacePattern,
): void => {
  if (pattern.kind === "identifier") {
    assertNotSymbolReference(pattern.name);
    return;
  }
  if (pattern.kind === "tuple") {
    pattern.elements.forEach(assertSurfacePatternBindingsAreBindable);
    return;
  }
  if (pattern.kind === "destructure") {
    pattern.fields.forEach(({ pattern: fieldPattern }) =>
      assertSurfacePatternBindingsAreBindable(fieldPattern),
    );
    if (pattern.spread) {
      assertSurfacePatternBindingsAreBindable(pattern.spread);
    }
    return;
  }
  assertSurfacePatternBindingsAreBindable(pattern.pattern);
};

const assertMatchPatternBindingsAreBindable = (
  pattern: SurfaceMatchPattern,
): void => {
  if (
    pattern.kind === "type-binding" ||
    pattern.kind === "tuple" ||
    pattern.kind === "destructure"
  ) {
    assertSurfacePatternBindingsAreBindable(pattern.binding);
  }
};

const declarationHeadValue = (form: Form): string | undefined => {
  const first = form.at(0);
  if (!isIdentifierAtom(first)) {
    return undefined;
  }
  if (!DECLARATION_MODIFIERS.has(first.value)) {
    return first.value;
  }
  const second = form.at(1);
  return isIdentifierAtom(second) ? second.value : undefined;
};

const assertDeclarationBindingsAreBindable = (
  form: Form,
  head: string,
): void => {
  if (head === "fn") {
    const declaration = parseFunctionDecl(form);
    if (!declaration) return;
    assertFunctionSignatureBindings(declaration.signature);
    declaration.signature.params.forEach(({ defaultValue }) => {
      if (defaultValue) {
        assertSymbolReferencesAreReferenceOnly(defaultValue);
      }
    });
    assertSymbolReferencesAreReferenceOnly(declaration.body);
    return;
  }
  if (head === "obj" || head === "val") {
    const declaration = parseObjectDecl(form);
    if (!declaration) return;
    assertNotSymbolReference(declaration.name);
    declaration.typeParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    declaration.fields.forEach(({ name }) => assertNotSymbolReference(name));
    return;
  }
  if (head === "type") {
    const declaration = parseTypeAliasDecl(form);
    if (!declaration) return;
    assertNotSymbolReference(declaration.name);
    declaration.typeParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    return;
  }
  if (head === "trait") {
    const declaration = parseTraitDecl(form);
    if (!declaration) return;
    assertNotSymbolReference(declaration.name);
    declaration.typeParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    declaration.regions.forEach(({ name }) => assertNotSymbolReference(name));
    declaration.methods.forEach(({ signature, body }) => {
      assertFunctionSignatureBindings(signature);
      signature.params.forEach(({ defaultValue }) => {
        if (defaultValue) {
          assertSymbolReferencesAreReferenceOnly(defaultValue);
        }
      });
      if (body) {
        assertSymbolReferencesAreReferenceOnly(body);
      }
    });
    return;
  }
  if (head === "eff") {
    let declaration: ReturnType<typeof parseEffectDecl>;
    try {
      declaration = parseEffectDecl(form);
    } catch {
      assertDeclarationHeaderNameIsBindable(form);
      return;
    }
    if (!declaration) return;
    assertNotSymbolReference(declaration.name);
    declaration.typeParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    declaration.operations.forEach((operation) => {
      assertNotSymbolReference(operation.name);
      operation.params.forEach(({ ast }) => assertParameterIsBindable(ast));
    });
    return;
  }
  if (head === "impl") {
    const declaration = parseImplDecl(form);
    if (!declaration) return;
    declaration.typeParameters.forEach(({ name }) =>
      assertNotSymbolReference(name),
    );
    declaration.methods.forEach((method) => {
      assertFunctionSignatureBindings(method.signature);
      method.signature.params.forEach(({ defaultValue }) => {
        if (defaultValue) {
          assertSymbolReferencesAreReferenceOnly(defaultValue);
        }
      });
      assertSymbolReferencesAreReferenceOnly(method.body);
    });
    return;
  }
  if (head === "macro" || head === "attribute") {
    assertMacroDeclarationBindingsAreBindable(form, head);
    return;
  }
  if (head === "macro_let") {
    assertMacroLetBindingIsBindable(form);
    return;
  }
  if (head === "functional-macro" || head === "attribute-macro") {
    assertRenderedMacroBindingsAreBindable(form);
    return;
  }
  if (head === "define-macro-variable") {
    assertNotSymbolReference(form.at(declarationOffset(form) + 1));
    return;
  }
  if (head === "use") {
    assertUseAliasesAreBindable(form.at(declarationOffset(form) + 1));
    return;
  }

  assertDeclarationHeaderNameIsBindable(form);
  form.rest.forEach((entry) => {
    if (isForm(entry) && entry.calls("block")) {
      assertSymbolReferencesAreReferenceOnly(entry);
    }
  });
};

const assertMacroDeclarationBindingsAreBindable = (
  form: Form,
  head: "macro" | "attribute",
): void => {
  const offset = declarationOffset(form);
  const signatureIndex = head === "attribute" ? offset + 2 : offset + 1;
  const signature = form.at(signatureIndex);
  if (!isForm(signature)) {
    return;
  }
  signature.toArray().forEach(assertNotSymbolReference);
  form
    .toArray()
    .slice(signatureIndex + 1)
    .forEach(assertSymbolReferencesAreReferenceOnly);
};

const assertMacroLetBindingIsBindable = (form: Form): void => {
  const assignment = form.at(declarationOffset(form) + 1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    return;
  }
  assertNotSymbolReference(assignment.at(1));
  const initializer = assignment.at(2);
  if (initializer) {
    assertSymbolReferencesAreReferenceOnly(initializer);
  }
};

const assertRenderedMacroBindingsAreBindable = (form: Form): void => {
  const offset = declarationOffset(form);
  assertNotSymbolReference(form.at(offset + 1));
  const parameters = form.at(offset + 2);
  if (isForm(parameters)) {
    parameters.rest.forEach(assertNotSymbolReference);
  }
  const body = form.at(offset + 3);
  if (body) {
    assertSymbolReferencesAreReferenceOnly(body);
  }
};

const assertUseAliasesAreBindable = (syntax: Expr | undefined): void => {
  if (isIdentifierAtom(syntax)) {
    assertNotSymbolReference(syntax);
    return;
  }
  if (!isForm(syntax)) {
    return;
  }
  if (syntax.calls("as")) {
    assertNotSymbolReference(syntax.at(2));
    return;
  }
  if (syntax.calls("::")) {
    assertUseAliasesAreBindable(syntax.at(2));
    return;
  }
  syntax.rest.forEach(assertUseAliasesAreBindable);
};

const declarationOffset = (form: Form): number => {
  const first = form.at(0);
  return isIdentifierAtom(first) && DECLARATION_MODIFIERS.has(first.value)
    ? 1
    : 0;
};

const assertDeclarationHeaderNameIsBindable = (form: Form): void => {
  const first = form.at(0);
  const headerIndex = DECLARATION_MODIFIERS.has(
    isIdentifierAtom(first) ? first.value : "",
  )
    ? 2
    : 1;
  const header = form.at(headerIndex);
  if (isIdentifierAtom(header)) {
    assertNotSymbolReference(header);
    return;
  }
  if (isForm(header)) {
    assertNotSymbolReference(header.at(0));
  }
};

const assertFunctionSignatureBindings = (
  signature: NonNullable<ReturnType<typeof parseFunctionDecl>>["signature"],
): void => {
  assertNotSymbolReference(signature.name);
  signature.typeParameters.forEach(({ name }) =>
    assertNotSymbolReference(name),
  );
  signature.params.forEach(({ ast }) => assertParameterIsBindable(ast));
};

const assertParameterIsBindable = (syntax: Syntax): void => {
  if (isIdentifierAtom(syntax)) {
    assertNotSymbolReference(syntax);
    return;
  }
  if (!isForm(syntax)) {
    return;
  }
  if (
    syntax.calls(":") ||
    syntax.calls("?:") ||
    syntax.calls("=") ||
    syntax.calls("~")
  ) {
    const binder = syntax.at(1);
    if (binder) {
      assertParameterIsBindable(binder);
    }
  }
};

const assertNotSymbolReference = (syntax: Expr | undefined): void => {
  if (
    isIdentifierAtom(syntax) &&
    syntax.lexicalContext?.kind === "symbol-reference"
  ) {
    throw new Error(
      `symbol_reference(${syntax.value}) is reference-only and cannot be used as a declaration name`,
    );
  }
};

const DECLARATION_HEADS = new Set([
  "fn",
  "type",
  "obj",
  "val",
  "trait",
  "eff",
  "impl",
  "mod",
  "macro",
  "attribute",
  "macro_let",
  "functional-macro",
  "attribute-macro",
  "define-macro-variable",
  "use",
]);

const DECLARATION_MODIFIERS = new Set(["pub", "api", "pri", "#"]);

const collectSyntaxLocationKeys = (roots: readonly Syntax[]): Set<string> => {
  const keys = new Set<string>();
  const visit = (syntax: Syntax): void => {
    const key = syntaxLocationKey(syntax);
    if (key) {
      keys.add(key);
    }
    if (isForm(syntax)) {
      syntax.toArray().forEach(visit);
    }
  };
  roots.forEach(visit);
  return keys;
};

const syntaxLocationKey = (syntax: Syntax): string | undefined => {
  const location = syntax.location;
  return location
    ? [
        syntax.syntaxType,
        location.filePath,
        location.startIndex,
        location.endIndex,
      ].join(":")
    : undefined;
};

function callLambda(lambda: MacroLambdaValue, args: Expr[]): MacroEvalResult {
  const lambdaScope = new MacroScope(lambda.scope);
  lambdaScope.defineVariable({
    name: new IdentifierAtom("&lambda"),
    value: cloneMacroEvalResult(lambda),
    mutable: false,
  });

  lambda.parameters.forEach((param, index) => {
    const arg = args.at(index);
    if (!arg) {
      throw new Error(
        `Lambda expected ${lambda.parameters.length} arguments, received ${index}`,
      );
    }
    lambdaScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(arg),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  lambda.body.forEach((expression) => {
    result = evalMacroExpr(cloneExpr(expression), lambdaScope);
  });

  return result;
}

const builtins = createBuiltins({
  evalMacroExpr,
  callLambda,
});

function transformDotCall(form: Form): Form {
  const left = form.at(1);
  const right = form.at(2);
  if (!left || !right) {
    throw new Error("dot expression missing target or member");
  }

  if (isForm(right) && formCallsInternal(right.at(1), "generics")) {
    const elements = right.toArray();
    return recreateForm(form, [
      elements[0]!,
      elements[1]!,
      left,
      ...elements.slice(2),
    ]);
  }

  if (isForm(right)) {
    const elements = right.toArray();
    return recreateForm(form, [elements[0]!, left, ...elements.slice(1)]);
  }

  return recreateForm(form, [right, left]);
}
