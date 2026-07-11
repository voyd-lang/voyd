import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { classifyTopLevelDecl } from "../surface/use-decl.js";
import { parseUsePaths } from "../surface/use-path.js";

/** Validates context-sensitive surface shapes after base syntax normalization. */
export const validateSurfaceSyntax = (ast: Form): Form => {
  validateModuleEntries(ast.rest);
  return ast;
};

const validateModuleEntries = (entries: readonly Expr[]): void =>
  entries.forEach((expr) => {
    if (!isForm(expr)) return;
    const declaration = classifyTopLevelDecl(expr);
    if (declaration.kind === "use-decl") {
      const invalidSeparator = findInvalidModuleSeparator(declaration.pathExpr);
      if (invalidSeparator) {
        throw new ParserSyntaxError(
          "Invalid module access syntax; use '::' between module path segments",
          invalidSeparator.location,
        );
      }
      parseUsePaths(declaration.pathExpr, {
        file: expr.location?.filePath ?? "<unknown>",
        start: expr.location?.startIndex ?? 0,
        end: expr.location?.endIndex ?? 0,
      });
      return;
    }
    if (declaration.kind === "inline-module-decl") {
      validateModuleEntries(declaration.body.rest);
    }
  });

const findInvalidModuleSeparator = (expr: Expr): Expr | undefined => {
  if (isIdentifierAtom(expr) && expr.value === ":") return expr;
  if (!isForm(expr)) return undefined;
  return expr
    .toArray()
    .map(findInvalidModuleSeparator)
    .find((candidate): candidate is Expr => candidate !== undefined);
};
