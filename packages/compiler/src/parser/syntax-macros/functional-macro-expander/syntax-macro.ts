import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  InternalIdentifierAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../ast/index.js";
import type { SyntaxMacro } from "../types.js";
import { SyntaxMacroError } from "../macro-error.js";
import {
  ensureForm,
  cloneExpr,
  expectForm,
  expectIdentifier,
  recreateForm,
  cloneMacroEvalResult,
} from "./helpers.js";
import { renderFunctionalMacro, renderMacroVariable } from "./renderers.js";
import { MacroScope } from "./scope.js";
import { evalMacroExpr, expandMacroCall } from "./evaluator.js";
import type { MacroDefinition, MacroVariableBinding } from "./types.js";
import { nextMacroId } from "./macro-id.js";

type MacroDefinitionInput = {
  kind: MacroDefinition["kind"];
  signature: Form;
  bodyExpressions: Expr[];
  visibility: "pub" | "module";
};

type ExpandFunctionalMacroOptions = {
  scope?: MacroScope;
  strictMacroSignatures?: boolean;
  onError?: (error: SyntaxMacroError) => void;
  maxAttributeExpansionDepth?: number;
  attributeExpansionDepth?: number;
  moduleId?: string;
  onAttributeExpansion?: (event: {
    invocationName: IdentifierAtom;
    macro: MacroDefinition;
  }) => void;
  onUnknownAttribute?: (invocationName: IdentifierAtom) => void;
};

const DEFAULT_MAX_ATTRIBUTE_EXPANSION_DEPTH = 64;
const RESERVED_ATTRIBUTE_NAMES = new Set([
  "boundary",
  "compiler_contract",
  "effect",
  "external",
  "intrinsic",
  "intrinsic_type",
  "serializer",
]);

export const functionalMacroExpander: SyntaxMacro = (form: Form): Form =>
  expandFunctionalMacros(form).form;

export const expandFunctionalMacros = (
  form: Form,
  options: ExpandFunctionalMacroOptions = {}
): { form: Form; exports: MacroDefinition[] } => {
  const scope = options.scope ?? new MacroScope();
  const exports: MacroDefinition[] = [];
  try {
    return { form: ensureForm(expandExpr(form, scope, exports, options)), exports };
  } catch (error) {
    const macroError = toSyntaxMacroError(error, form);
    if (!options.onError) {
      throw macroError;
    }
    options.onError(macroError);
    return { form, exports };
  }
};

const expandExpr = (
  expr: Expr,
  scope: MacroScope,
  exports: MacroDefinition[],
  options: ExpandFunctionalMacroOptions
): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  try {
    const macroDefinition = parseMacroDefinition({
      form: expr,
      strictMacroSignatures: options.strictMacroSignatures === true,
    });
    if (macroDefinition) {
      return expandMacroDefinition(
        macroDefinition,
        scope,
        exports,
        options.moduleId,
      );
    }

    if (expr.calls("macro_let")) {
      return expandMacroLet(expr, scope);
    }

    if (isAttributeForm(expr)) {
      return expr;
    }

    const head = expr.at(0);
    const macro = isIdentifierAtom(head) ? scope.getMacro(head.value) : undefined;
    if (macro) {
      if (macro.kind === "attribute") {
        throw new SyntaxMacroError(
          `Attribute macro '${macro.name.value}' must be invoked with '@' before a declaration`,
          expr,
        );
      }
      const expanded = expandMacroCall(expr, macro, scope);
      return expandExpr(expanded, scope, exports, options);
    }

    const visibilityWrapped = expandVisibilityWrappedMacroCall({
      expr,
      scope,
      exports,
      options,
    });
    if (visibilityWrapped) {
      return visibilityWrapped;
    }

    return expandForm(expr, scope, exports, options);
  } catch (error) {
    throw toSyntaxMacroError(error, expr);
  }
};

const expandForm = (
  form: Form,
  scope: MacroScope,
  exports: MacroDefinition[],
  options: ExpandFunctionalMacroOptions
): Form => {
  const head = form.at(0);
  const bodyScope = createsScopeFor(head) ? scope.child() : scope;
  const elements = form.toArray();
  const result: Expr[] = [];
  const allowsAttributes = isTopLevelAst(form) || form.calls("block");

  for (let index = 0; index < elements.length; index += 1) {
    const child = elements[index]!;
    if (isModuleName(head, index)) {
      result.push(child);
      continue;
    }

    if (allowsAttributes && isForm(child) && isAttributeForm(child)) {
      const { attributes, targetIndex } = collectConsecutiveAttributes({
        elements,
        startIndex: index,
      });
      const target = elements[targetIndex];
      if (!target) {
        throw new SyntaxMacroError(
          "attribute is missing a following declaration",
          child,
        );
      }
      const exportedMacroCount = exports.length;
      const rollbackScope = bodyScope.checkpoint();
      const pendingErrors: SyntaxMacroError[] = [];
      const pendingUnknownAttributes: IdentifierAtom[] = [];
      const pendingAttributeExpansions: Array<{
        invocationName: IdentifierAtom;
        macro: MacroDefinition;
      }> = [];
      const transactionOptions: ExpandFunctionalMacroOptions = {
        ...options,
        onError: options.onError
          ? (error) => pendingErrors.push(error)
          : undefined,
        onUnknownAttribute: options.onUnknownAttribute
          ? (name) => pendingUnknownAttributes.push(name)
          : undefined,
        onAttributeExpansion: options.onAttributeExpansion
          ? (event) => pendingAttributeExpansions.push(event)
          : undefined,
      };
      try {
        result.push(
          ...expandAttributedDeclaration({
            attributes,
            target,
            scope: bodyScope,
            exports,
            options: transactionOptions,
          }),
        );
        pendingErrors.forEach((error) => options.onError?.(error));
        pendingUnknownAttributes.forEach((name) =>
          options.onUnknownAttribute?.(name),
        );
        pendingAttributeExpansions.forEach((event) =>
          options.onAttributeExpansion?.(event),
        );
      } catch (error) {
        exports.length = exportedMacroCount;
        rollbackScope();
        const macroError = toSyntaxMacroError(error, child);
        if (!options.onError) {
          throw macroError;
        }
        options.onError(macroError);
        result.push(
          ...expandTargetWithoutUserAttributes({
            attributes,
            target,
            scope: bodyScope,
            exports,
            options,
          }),
        );
      }
      index = targetIndex;
      continue;
    }

    const expanded = expandExpr(child, bodyScope, exports, options);
    if (allowsAttributes && isForm(expanded) && isEmitManyForm(expanded)) {
      const emittedSequence = new Form({
        location: expanded.location?.clone(),
        elements: [
          new InternalIdentifierAtom("ast"),
          ...expanded.rest.map(cloneExpr),
        ],
      });
      result.push(
        ...expandForm(emittedSequence, bodyScope, exports, options).rest,
      );
      continue;
    }
    result.push(expanded);
  }

  return recreateForm(form, result);
};

type ParsedAttribute = {
  form: Form;
  name: IdentifierAtom;
  args: readonly Expr[];
};

const isAttributeForm = (expr: Expr): boolean =>
  isForm(expr) && expr.calls("@");

const parseAttribute = (form: Form): ParsedAttribute => {
  const target = form.at(1);
  if (isIdentifierAtom(target)) {
    return { form, name: target, args: [] };
  }
  if (isForm(target)) {
    const name = target.at(0);
    if (isIdentifierAtom(name)) {
      return { form, name, args: target.rest };
    }
  }
  throw new SyntaxMacroError("attribute name must be an identifier", form);
};

const collectConsecutiveAttributes = ({
  elements,
  startIndex,
}: {
  elements: readonly Expr[];
  startIndex: number;
}): { attributes: ParsedAttribute[]; targetIndex: number } => {
  const attributes: ParsedAttribute[] = [];
  let targetIndex = startIndex;
  while (targetIndex < elements.length) {
    const candidate = elements[targetIndex];
    if (!candidate || !isForm(candidate) || !isAttributeForm(candidate)) {
      break;
    }
    attributes.push(parseAttribute(candidate));
    targetIndex += 1;
  }
  return { attributes, targetIndex };
};

const expandAttributedDeclaration = ({
  attributes,
  target,
  scope,
  exports,
  options,
}: {
  attributes: readonly ParsedAttribute[];
  target: Expr;
  scope: MacroScope;
  exports: MacroDefinition[];
  options: ExpandFunctionalMacroOptions;
}): Expr[] => {
  if (!isSupportedAttributeTarget(target)) {
    throw new SyntaxMacroError(
      "attributes must precede a supported declaration",
      target,
    );
  }

  const reserved: Form[] = [];
  const userAttributes: Array<ParsedAttribute & { macro: MacroDefinition }> = [];
  const seenUserAttributes = new Set<string>();

  for (const attribute of attributes) {
    const name = attribute.name.value;
    if (RESERVED_ATTRIBUTE_NAMES.has(name)) {
      reserved.push(attribute.form.clone());
      continue;
    }

    let macro: MacroDefinition | undefined;
    try {
      macro = scope.getMacro(name);
    } catch (error) {
      throw new SyntaxMacroError(
        error instanceof Error ? error.message : String(error),
        attribute.form,
      );
    }
    if (!macro) {
      if (!options.onUnknownAttribute) {
        return [
          ...attributes.map((entry) => entry.form.clone()),
          expandExpr(target, scope, exports, options),
        ];
      }
      options.onUnknownAttribute(attribute.name);
      return expandTargetWithoutUserAttributes({
        attributes,
        target,
        scope,
        exports,
        options,
      });
    }
    if (macro.kind !== "attribute") {
      throw new SyntaxMacroError(
        `'@${name}' resolves to a functional macro, not an attribute macro`,
        attribute.form,
      );
    }
    if (seenUserAttributes.has(name)) {
      throw new SyntaxMacroError(
        `duplicate user-defined attribute '@${name}'`,
        attribute.form,
      );
    }
    seenUserAttributes.add(name);
    userAttributes.push({ ...attribute, macro });
  }

  if (userAttributes.length === 0) {
    return [...reserved, expandExpr(target, scope, exports, options)];
  }

  const depth = options.attributeExpansionDepth ?? 0;
  const maxDepth =
    options.maxAttributeExpansionDepth ?? DEFAULT_MAX_ATTRIBUTE_EXPANSION_DEPTH;
  if (depth >= maxDepth) {
    throw new SyntaxMacroError(
      `attribute macro expansion exceeded the depth limit of ${maxDepth}`,
      userAttributes[0]!.form,
    );
  }

  let expanded = cloneExpr(target);
  userAttributes.forEach(({ form, macro, args }) => {
    options.onAttributeExpansion?.({
      invocationName: parseAttribute(form).name,
      macro,
    });
    const argumentList = new Form({
      location: form.location?.clone(),
      elements: args.map(cloneExpr),
    });
    const invocation = new Form({
      location: form.location?.clone(),
      elements: [macro.name.clone(), argumentList, expanded],
    });
    expanded = expandMacroCall(invocation, macro, scope);
  });

  const emitted =
    isForm(expanded) && isEmitManyForm(expanded) ? expanded.rest : [expanded];
  const expansionAst = new Form({
    location: expanded.location?.clone(),
    elements: [
      new InternalIdentifierAtom("ast"),
      ...emitted.map(cloneExpr),
    ],
  });
  const recursivelyExpanded = expandExpr(expansionAst, scope, exports, {
    ...options,
    attributeExpansionDepth: depth + 1,
  });
  return [
    ...reserved,
    ...(isForm(recursivelyExpanded) && isTopLevelAst(recursivelyExpanded)
      ? recursivelyExpanded.rest
      : [recursivelyExpanded]),
  ];
};

const expandTargetWithoutUserAttributes = ({
  attributes,
  target,
  scope,
  exports,
  options,
}: {
  attributes: readonly ParsedAttribute[];
  target: Expr;
  scope: MacroScope;
  exports: MacroDefinition[];
  options: ExpandFunctionalMacroOptions;
}): Expr[] => [
  ...attributes
    .filter((entry) => RESERVED_ATTRIBUTE_NAMES.has(entry.name.value))
    .map((entry) => entry.form.clone()),
  expandExpr(target, scope, exports, options),
];

const isSupportedAttributeTarget = (expr: Expr): expr is Form => {
  if (!isForm(expr)) {
    return false;
  }
  const first = expr.at(0);
  const keyword =
    isIdentifierAtom(first) && DECLARATION_MODIFIERS.has(first.value)
      ? expr.at(1)
      : first;
  return isIdentifierAtom(keyword) && ATTRIBUTE_TARGET_HEADS.has(keyword.value);
};

const DECLARATION_MODIFIERS = new Set(["pub", "api", "pri", "#"]);

const ATTRIBUTE_TARGET_HEADS = new Set([
  "fn",
  "let",
  "type",
  "obj",
  "val",
  "trait",
  "impl",
  "eff",
  "mod",
  "test",
  "enum",
]);

const expandVisibilityWrappedMacroCall = ({
  expr,
  scope,
  exports,
  options,
}: {
  expr: Form;
  scope: MacroScope;
  exports: MacroDefinition[];
  options: ExpandFunctionalMacroOptions;
}): Expr | undefined => {
  const visibility = expr.at(0);
  const macroName = expr.at(1);
  if (!isIdentifierAtom(visibility) || visibility.value !== "pub") {
    return undefined;
  }
  if (!isIdentifierAtom(macroName)) {
    return undefined;
  }

  const macro = scope.getMacro(macroName.value);
  if (!macro) {
    return undefined;
  }
  if (macro.kind === "attribute") {
    throw new SyntaxMacroError(
      `Attribute macro '${macro.name.value}' must be invoked with '@' before a declaration`,
      expr,
    );
  }

  const invocation = recreateForm(expr, [macroName, ...expr.toArray().slice(2)]);
  const expanded = expandMacroCall(invocation, macro, scope);
  const withVisibility = applyPubVisibility(expanded);
  return expandExpr(withVisibility, scope, exports, options);
};

const applyPubVisibility = (expr: Expr): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  if (expr.calls("block") || isEmitManyForm(expr)) {
    return recreateForm(expr, [
      expr.first!,
      ...expr.rest.map((entry) => withPubModifier(entry)),
    ]);
  }

  return withPubModifier(expr);
};

const withPubModifier = (expr: Expr): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  const first = expr.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") {
    return expr;
  }
  if (!isIdentifierAtom(first) || !PUB_ELIGIBLE_TOP_LEVEL_HEADS.has(first.value)) {
    return expr;
  }

  return recreateForm(expr, [new IdentifierAtom("pub"), ...expr.toArray()]);
};

const isTopLevelAst = (form: Form): boolean =>
  form.callsInternal("ast") || form.calls("ast");

const isEmitManyForm = (form: Form): boolean => {
  if (form.callsInternal("emit_many")) {
    return true;
  }
  const head = form.at(0);
  return isInternalIdentifierAtom(head) && head.value === "emit_many";
};

const PUB_ELIGIBLE_TOP_LEVEL_HEADS = new Set([
  "fn",
  "type",
  "obj",
  "val",
  "trait",
  "impl",
  "eff",
  "mod",
  "use",
  "macro",
  "macro_let",
  "functional-macro",
  "define-macro-variable",
]);

const expandMacroDefinition = (
  definition: MacroDefinitionInput,
  scope: MacroScope,
  exports: MacroDefinition[],
  moduleId: string | undefined,
): Expr => {
  const signature = definition.signature;
  const name = expectIdentifier(signature.at(0), "macro name");
  const parameters = signature
    .toArray()
    .slice(1)
    .map((expr, index) =>
      expectIdentifier(
        expr,
        `macro parameter ${index + 1} for ${name.value ?? "anonymous macro"}`
      ).clone()
    );

  const macro: MacroDefinition = {
    kind: definition.kind,
    name: name.clone(),
    declarationName: name.clone(),
    parameters,
    body: definition.bodyExpressions,
    scope,
    id: new IdentifierAtom(`${name.value}#${nextMacroId()}`),
    moduleId,
  };

  scope.defineMacro(macro);
  if (definition.visibility === "pub") {
    exports.push(macro);
  }
  return renderFunctionalMacro(macro);
};

const expandMacroLet = (form: Form, scope: MacroScope): Expr => {
  const assignment = expectForm(form.at(1), "macro let assignment");
  const operator = assignment.at(0);
  if (!isIdentifierAtom(operator) || operator.value !== "=") {
    throw new Error("macro_let expects an assignment expression");
  }
  const identifier = expectIdentifier(assignment.at(1), "macro let identifier");
  const initializer = assignment.at(2);
  if (!initializer) {
    throw new Error("macro_let requires an initializer");
  }

  const value = evalMacroExpr(cloneExpr(initializer), scope);
  const binding: MacroVariableBinding = {
    name: identifier.clone(),
    value: cloneMacroEvalResult(value),
    mutable: false,
  };
  scope.defineVariable(binding);

  return renderMacroVariable(binding);
};

const createsScopeFor = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) &&
  (expr.value === "block" ||
    expr.value === "module" ||
    expr.value === "fn" ||
    expr.value === "ast");

const isModuleName = (head: Expr | undefined, index: number): boolean =>
  isIdentifierAtom(head) && head.value === "module" && index === 1;

const parseMacroDefinition = ({
  form,
  strictMacroSignatures,
}: {
  form: Form;
  strictMacroSignatures: boolean;
}): MacroDefinitionInput | null => {
  let index = 0;
  let visibility: MacroDefinitionInput["visibility"] = "module";
  let kind: MacroDefinitionInput["kind"] = "function";
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = "pub";
    index = 1;
  }

  let keyword = form.at(index);
  if (isIdentifierAtom(keyword) && keyword.value === "attribute") {
    kind = "attribute";
    index += 1;
    keyword = form.at(index);
  }
  if (!isIdentifierAtom(keyword) || keyword.value !== "macro") {
    return null;
  }

  const signatureExpr = form.at(index + 1);
  if (!signatureExpr) {
    if (strictMacroSignatures) {
      throw new Error("macro missing signature");
    }
    return null;
  }
  if (!isForm(signatureExpr)) {
    if (strictMacroSignatures) {
      throw new Error("Expected form for macro signature");
    }
    return null;
  }

  const signature = signatureExpr;
  const bodyExpressions = form
    .toArray()
    .slice(index + 2)
    .map(cloneExpr);

  if (kind === "attribute") {
    const name = signature.at(0);
    if (isIdentifierAtom(name) && RESERVED_ATTRIBUTE_NAMES.has(name.value)) {
      throw new Error(`attribute macro name '${name.value}' is reserved`);
    }
    if (signature.length !== 3) {
      throw new Error(
        "attribute macro signature must accept (arguments, declaration)",
      );
    }
  }

  return { kind, signature, bodyExpressions, visibility };
};

const toSyntaxMacroError = (error: unknown, syntax: Expr): SyntaxMacroError => {
  if (error instanceof SyntaxMacroError) {
    return error.syntax ? error : new SyntaxMacroError(error.message, syntax);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new SyntaxMacroError(message, syntax);
};
