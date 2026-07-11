import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { parseSurfaceLambdaExpression } from "./lambda.js";
import { parseSurfacePattern, type SurfacePattern } from "./patterns.js";
import { parseIfBranches, parseWhileConditionAndBody } from "./utils.js";
import { parseRecordFields, parseValueBraceEntries } from "./brace-entries.js";
import { parseSurfaceFunctionType } from "./function-type-annotations.js";
import { parseSurfaceCallArguments } from "./call-arguments.js";
import { classifySurfaceForm } from "./form-classification.js";
import { parseSurfaceHandlerClause, parseSurfaceTryExpression } from "./try.js";

export type SurfaceBindingStatement = {
  kind: "let" | "var";
  form: Form;
  patternExpr: Expr;
  pattern: ReturnType<typeof parseSurfacePattern>;
  initializer: Expr;
};

export type SurfaceMatchExpression = {
  form: Form;
  operand: Expr;
  binder?: import("../ast/index.js").IdentifierAtom;
  arms: readonly { form: Form; pattern: SurfaceMatchPattern; value: Expr }[];
};

export type SurfaceMatchPattern =
  | { kind: "wildcard"; syntax: Expr }
  | { kind: "type"; typeExpr: Expr; syntax: Expr }
  | {
      kind: "type-binding";
      typeExpr: Expr;
      binding: SurfacePattern;
      syntax: Form;
    }
  | { kind: "tuple"; binding: SurfacePattern; syntax: Form }
  | {
      kind: "destructure";
      typeExpr: Expr;
      binding: SurfacePattern;
      syntax: Form;
    };

const bindingCache = new WeakMap<Form, SurfaceBindingStatement>();
const matchCache = new WeakMap<Form, SurfaceMatchExpression>();
const matchPatternCache = new WeakMap<Expr, SurfaceMatchPattern>();
const validatedHandlerClauses = new WeakSet<Form>();

export const parseSurfaceBindingStatement = (
  form: Form,
): SurfaceBindingStatement => {
  const cached = bindingCache.get(form);
  if (cached) return cached;
  const kind = form.calls("var") ? "var" : "let";
  const assignment = form.at(1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    throw new ParserSyntaxError(
      `${kind} statement expects an assignment`,
      form.location,
    );
  }
  const patternExpr = assignment.at(1);
  const initializer = assignment.at(2);
  if (!patternExpr || !initializer) {
    throw new ParserSyntaxError(
      "let/var statement missing pattern or initializer",
      form.location,
    );
  }
  const parsed = {
    kind,
    form,
    patternExpr,
    pattern: parseSurfacePattern(patternExpr),
    initializer,
  } satisfies SurfaceBindingStatement;
  bindingCache.set(form, parsed);
  return parsed;
};

export const parseSurfaceMatchExpression = (
  form: Form,
  operandOverride?: Expr,
): SurfaceMatchExpression => {
  if (!operandOverride) {
    const cached = matchCache.get(form);
    if (cached) return cached;
  }
  const operand = operandOverride ?? form.at(1);
  if (!operand) {
    throw new ParserSyntaxError(
      "match expression missing discriminant",
      form.location,
    );
  }
  const potentialBinder = operandOverride ? form.at(1) : form.at(2);
  const binder = isIdentifierAtom(potentialBinder)
    ? potentialBinder
    : undefined;
  const caseStart = binder
    ? operandOverride
      ? 2
      : 3
    : operandOverride
      ? 1
      : 2;
  const arms = form
    .toArray()
    .slice(caseStart)
    .map((arm) => {
      if (!isForm(arm) || !arm.calls(":")) {
        throw new ParserSyntaxError(
          "match cases must be labeled with ':'",
          arm.location,
        );
      }
      const pattern = arm.at(1);
      const value = arm.at(2);
      if (!pattern || !value) {
        throw new ParserSyntaxError(
          "match case missing pattern or value",
          arm.location,
        );
      }
      return {
        form: arm,
        pattern: parseSurfaceMatchPattern(pattern),
        value,
      };
    });
  const parsed = {
    form,
    operand,
    binder,
    arms,
  } satisfies SurfaceMatchExpression;
  if (!operandOverride) matchCache.set(form, parsed);
  return parsed;
};

export const parseSurfaceMatchPattern = (expr: Expr): SurfaceMatchPattern => {
  const cached = matchPatternCache.get(expr);
  if (cached) return cached;

  const parsed = (() => {
    if (
      isIdentifierAtom(expr) &&
      (expr.value === "_" || expr.value === "else")
    ) {
      return { kind: "wildcard", syntax: expr } as const;
    }
    if (isForm(expr) && expr.calls("as")) {
      const typeExpr = expr.at(1);
      const bindingExpr = expr.at(2);
      if (!typeExpr || !bindingExpr) {
        throw new ParserSyntaxError(
          "match pattern 'as' is missing a target or binding",
          expr.location,
        );
      }
      return {
        kind: "type-binding",
        typeExpr,
        binding: parseSurfacePattern(bindingExpr),
        syntax: expr,
      } as const;
    }
    if (isForm(expr) && (expr.calls("tuple") || expr.callsInternal("tuple"))) {
      return {
        kind: "tuple",
        binding: parseSurfacePattern(expr),
        syntax: expr,
      } as const;
    }
    if (isForm(expr)) {
      const last = expr.at(-1);
      if (isForm(last) && last.callsInternal("object_literal")) {
        const typeExpr = expr.slice(0, -1).unwrap();
        if (isForm(typeExpr) && typeExpr.length === 0) {
          throw new ParserSyntaxError(
            "match destructure pattern is missing a type",
            expr.location,
          );
        }
        return {
          kind: "destructure",
          typeExpr,
          binding: parseSurfacePattern(last),
          syntax: expr,
        } as const;
      }
    }
    return { kind: "type", typeExpr: expr, syntax: expr } as const;
  })();
  matchPatternCache.set(expr, parsed);
  return parsed;
};

export const validateSurfaceTypeExpression = (expr: Expr | undefined): void => {
  if (!expr || !isForm(expr)) return;
  if (expr.callsInternal("object_literal")) {
    parseRecordFields(expr).forEach((field) =>
      validateSurfaceTypeExpression(field.value),
    );
    return;
  }
  const effectTail = expr.calls(":") ? expr.at(2) : undefined;
  if (
    expr.calls("->") ||
    expr.calls("fn") ||
    (isForm(effectTail) && effectTail.calls("->"))
  ) {
    const functionType = parseSurfaceFunctionType(expr);
    functionType.parameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.typeExpr),
    );
    validateSurfaceTypeExpression(functionType.returnType);
    validateSurfaceTypeExpression(functionType.effectType);
    return;
  }
  expr.toArray().forEach(validateSurfaceTypeExpression);
};

/** Validates context-free expression structure without resolving names or types. */
export const validateSurfaceExpression = (expr: Expr | undefined): void => {
  if (!expr || !isForm(expr)) return;

  if (validatedHandlerClauses.has(expr)) {
    validateSurfaceExpression(parseSurfaceHandlerClause(expr).body);
    return;
  }
  if (expr.calls("if")) {
    const { branches, defaultBranch } = parseIfBranches(expr);
    branches.forEach(({ condition, value }) => {
      validateSurfaceExpression(condition);
      validateSurfaceExpression(value);
    });
    validateSurfaceExpression(defaultBranch);
    return;
  }
  if (expr.calls("while")) {
    const { condition, body } = parseWhileConditionAndBody(expr);
    validateSurfaceExpression(condition);
    validateSurfaceExpression(body);
    return;
  }
  if (expr.calls("=>")) {
    validateLambda(expr);
    return;
  }
  if (expr.calls("let") || expr.calls("var")) {
    validateBinding(expr);
    return;
  }
  if (expr.calls("match")) {
    validateMatch(expr);
    return;
  }
  if (expr.calls("try")) validateTry(expr);
  if (expr.calls("return") && expr.length > 2) {
    throw new ParserSyntaxError(
      "return statement expects zero or one value",
      expr.location,
    );
  }
  if (expr.callsInternal("object_literal")) {
    parseValueBraceEntries(expr).forEach((entry) =>
      validateSurfaceExpression(entry.value),
    );
    return;
  }
  if (classifySurfaceForm(expr) === "call") {
    parseSurfaceCallArguments(expr.rest);
  }

  expr.toArray().forEach(validateSurfaceExpression);
};

const validateLambda = (form: Form): void => {
  const { signature, body } = parseSurfaceLambdaExpression(form);
  signature.normalizedParameters.forEach((parameter) =>
    validateSurfaceTypeExpression(parameter.typeExpr),
  );
  validateSurfaceTypeExpression(signature.returnType);
  validateSurfaceTypeExpression(signature.effectType);
  validateSurfaceExpression(body);
};

const validateBinding = (form: Form): void => {
  const binding = parseSurfaceBindingStatement(form);
  validatePatternTypes(binding.pattern);
  validateSurfaceExpression(binding.initializer);
};

const validateMatch = (form: Form): void => {
  const match = parseSurfaceMatchExpression(form);
  validateSurfaceExpression(match.operand);
  match.arms.forEach(({ pattern, value }) => {
    if ("typeExpr" in pattern) validateSurfaceTypeExpression(pattern.typeExpr);
    validateSurfaceExpression(value);
  });
};

const validatePatternTypes = (pattern: SurfacePattern): void => {
  if (pattern.kind === "typed") {
    validateSurfaceTypeExpression(pattern.typeExpr);
    validatePatternTypes(pattern.pattern);
    return;
  }
  if (pattern.kind === "tuple") {
    pattern.elements.forEach(validatePatternTypes);
    return;
  }
  if (pattern.kind === "destructure") {
    pattern.fields.forEach((field) => validatePatternTypes(field.pattern));
    if (pattern.spread) validatePatternTypes(pattern.spread);
  }
};

const validateTry = (form: Form): void => {
  const { body, bodyIndex } = parseSurfaceTryExpression(form);
  validateEmbeddedQualifiedHandlers(body);
  form.rest.slice(bodyIndex).forEach((entry) => {
    if (isForm(entry) && entry.calls(":")) validateHandlerClause(entry);
  });
};

const validateHandlerClause = (form: Form): void => {
  const clause = parseSurfaceHandlerClause(form);
  validatedHandlerClauses.add(form);
  clause.head.parameters.forEach((parameter) =>
    validateSurfaceTypeExpression(parameter.typeExpr),
  );
};

const validateEmbeddedQualifiedHandlers = (expr: Expr): void => {
  if (!isForm(expr) || expr.calls("try")) return;
  const potentialHead = expr.at(1);
  if (expr.calls(":") && isForm(potentialHead) && potentialHead.calls("::")) {
    validateHandlerClause(expr);
  }
  expr.toArray().forEach(validateEmbeddedQualifiedHandlers);
};
