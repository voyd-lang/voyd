import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { POSSIBLE_MISSING_BRACE_ENTRY_COMMA_ATTRIBUTE } from "../attributes.js";
import { ParserSyntaxError } from "../errors.js";

export const validateBraceEntrySyntax = (ast: Form): Form => {
  visit(ast);
  return ast;
};

const visit = (expr: Expr): void => {
  if (!isForm(expr)) return;
  if (isUseDeclaration(expr)) return;

  if (expr.callsInternal("object_literal")) {
    const missingCommaField = findMarkedField(expr);
    if (missingCommaField) {
      throw new ParserSyntaxError(
        `Expected ',' before '${missingCommaField.value}' in braces`,
        missingCommaField.location,
      );
    }
  }

  expr.toArray().forEach(visit);
};

const isUseDeclaration = (form: Form): boolean =>
  isIdentifierWithValue(form.at(0), "use") ||
  (isIdentifierWithValue(form.at(0), "pub") &&
    (isIdentifierWithValue(form.at(1), "use") || isModulePathForm(form.at(1))));

const isModulePathForm = (expr: Expr | undefined): boolean =>
  isForm(expr) && (expr.calls("::") || expr.calls(":"));

const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string,
): boolean => isIdentifierAtom(expr) && expr.value === value;

const findMarkedField = (expr: Expr): ReturnType<typeof markedField> => {
  if (isIdentifierAtom(expr)) return markedField(expr);
  if (!isForm(expr)) return undefined;
  if (callsControlFlowForm(expr)) {
    return expr.rest
      .map(findMarkedFieldInControlFlowChild)
      .find((candidate) => candidate !== undefined);
  }

  return expr
    .toArray()
    .map(findMarkedField)
    .find((candidate) => candidate !== undefined);
};

const findMarkedFieldInControlFlowChild = (
  expr: Expr,
): ReturnType<typeof markedField> => {
  if (!isForm(expr) || !expr.calls(":")) return findMarkedField(expr);

  return expr
    .toArray()
    .slice(2)
    .map(findMarkedField)
    .find((candidate) => candidate !== undefined);
};

const markedField = (expr: Expr) =>
  isIdentifierAtom(expr) &&
  expr.attributes?.[POSSIBLE_MISSING_BRACE_ENTRY_COMMA_ATTRIBUTE] === true
    ? expr
    : undefined;

const callsControlFlowForm = (form: Form): boolean =>
  form.calls("if") || form.calls("match") || form.calls("try");
