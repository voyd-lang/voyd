import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";

export const validateUseSyntax = (ast: Form): Form => {
  validateModuleEntries(ast.rest);
  return ast;
};

const validateModuleEntries = (entries: readonly Expr[]): void =>
  entries.forEach(validateModuleEntry);

const validateModuleEntry = (expr: Expr): void => {
  if (!isForm(expr)) return;

  const path = modulePathExpression(expr);
  if (path) {
    const invalidSeparator = findInvalidModuleSeparator(path);
    if (invalidSeparator) {
      throw new ParserSyntaxError(
        "Invalid module access syntax; use '::' between module path segments",
        invalidSeparator.location,
      );
    }
  }

  if (!isInlineModuleDeclaration(expr)) return;
  const body = expr
    .toArray()
    .find(
      (entry): entry is Form => isForm(entry) && entry.calls("block"),
    );
  if (body) validateModuleEntries(body.rest);
};

const isInlineModuleDeclaration = (form: Form): boolean =>
  isIdentifierWithValue(form.at(0), "mod") ||
  (isIdentifierWithValue(form.at(0), "pub") &&
    isIdentifierWithValue(form.at(1), "mod"));

const findInvalidModuleSeparator = (
  expr: Expr | undefined,
): Expr | undefined => {
  if (!expr) return undefined;
  if (isIdentifierWithValue(expr, ":")) return expr;
  if (!isForm(expr)) return undefined;

  return expr
    .toArray()
    .map(findInvalidModuleSeparator)
    .find((candidate): candidate is Expr => candidate !== undefined);
};

const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string,
): boolean => isIdentifierAtom(expr) && expr.value === value;

const modulePathExpression = (form: Form): Expr | undefined => {
  if (isIdentifierWithValue(form.at(0), "use")) return form.at(1);
  if (!isIdentifierWithValue(form.at(0), "pub")) return undefined;
  if (isIdentifierWithValue(form.at(1), "use")) return form.at(2);

  const bareExport = form.at(1);
  return isForm(bareExport) && (bareExport.calls("::") || bareExport.calls(":"))
    ? bareExport
    : undefined;
};
