import type { SourceSpan } from "../../diagnostics/index.js";
import {
  type Form,
  type Syntax,
  formCallsInternal,
  isForm,
} from "../ast/index.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseImplDecl,
  parseModuleLetDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
  type ParsedEffectDecl,
  type ParsedFunctionDecl,
  type ParsedImplDecl,
  type ParsedModuleLetDecl,
  type ParsedObjectDecl,
  type ParsedTraitDecl,
  type ParsedTypeAliasDecl,
} from "./declarations.js";
import {
  classifyTopLevelDecl,
  type TopLevelDeclClassification,
} from "./use-decl.js";
import { parseUsePaths, type NormalizedUseEntry } from "./use-path.js";
import {
  validateSurfaceExpression,
  validateSurfaceTypeExpression,
} from "./expressions.js";
import { ParserSyntaxError } from "../errors.js";

export type SurfaceUseDecl = {
  kind: "use";
  form: Form;
  visibility: "module" | "pub";
  entries: readonly NormalizedUseEntry[];
};

export type SurfaceModuleItem =
  | SurfaceUseDecl
  | {
      kind: "inline-module";
      form: Form;
      declaration: Extract<
        TopLevelDeclClassification,
        { kind: "inline-module-decl" }
      >;
    }
  | {
      kind: "unsupported-module";
      form: Form;
      declaration: Extract<
        TopLevelDeclClassification,
        { kind: "unsupported-mod-decl" }
      >;
    }
  | {
      kind: "macro";
      form: Form;
      declaration: Extract<TopLevelDeclClassification, { kind: "macro-decl" }>;
    }
  | { kind: "function"; declaration: ParsedFunctionDecl }
  | { kind: "module-let"; declaration: ParsedModuleLetDecl }
  | { kind: "type-alias"; declaration: ParsedTypeAliasDecl }
  | { kind: "object"; declaration: ParsedObjectDecl }
  | { kind: "trait"; declaration: ParsedTraitDecl }
  | { kind: "impl"; declaration: ParsedImplDecl }
  | { kind: "effect"; declaration: ParsedEffectDecl };

export type SurfaceSyntaxIssue = {
  message: string;
  span: SourceSpan;
};

export type ModuleHeaderView = {
  items: readonly (
    | SurfaceUseDecl
    | {
        kind: "inline-module";
        form: Form;
        declaration: Extract<
          TopLevelDeclClassification,
          { kind: "inline-module-decl" }
        >;
      }
    | {
        kind: "unsupported-module";
        form: Form;
        declaration: Extract<
          TopLevelDeclClassification,
          { kind: "unsupported-mod-decl" }
        >;
      }
    | {
        kind: "macro";
        form: Form;
        declaration: Extract<
          TopLevelDeclClassification,
          { kind: "macro-decl" }
        >;
      }
  )[];
};

export type SurfaceModuleView = {
  ast: Form;
  items: readonly SurfaceModuleItem[];
  issues: readonly SurfaceSyntaxIssue[];
};

export const createModuleHeaderView = (ast: Form): ModuleHeaderView => {
  const items: ModuleHeaderView["items"][number][] = [];
  moduleEntries(ast).forEach((form) => {
    const item = headerItemFor(form);
    if (item) items.push(item);
  });
  return { items };
};

export const createSurfaceModuleView = (ast: Form): SurfaceModuleView => {
  const items: SurfaceModuleItem[] = [];
  const issues: SurfaceSyntaxIssue[] = [];

  moduleEntries(ast).forEach((form) => {
    try {
      const headerItem = headerItemFor(form);
      if (headerItem) {
        items.push(headerItem);
        return;
      }

      const parsed = parseOrdinaryDeclaration(form);
      if (parsed) {
        items.push(parsed);
        validateSurfaceItem(parsed);
        return;
      }

      issues.push({
        message: "unsupported top-level form; expected a declaration",
        span: sourceSpanOf(form),
      });
    } catch (error) {
      issues.push({
        message: error instanceof Error ? error.message : String(error),
        span:
          error instanceof ParserSyntaxError && error.location
            ? sourceSpanFromLocation(error.location)
            : sourceSpanOf(form),
      });
    }
  });

  return { ast, items, issues };
};

const validateSurfaceItem = (item: SurfaceModuleItem): void => {
  if (item.kind === "function") {
    validateFunctionTypes(item.declaration);
    validateSurfaceExpression(item.declaration.body);
    return;
  }
  if (item.kind === "module-let") {
    validateSurfaceTypeExpression(item.declaration.typeExpr);
    validateSurfaceExpression(item.declaration.initializer);
    return;
  }
  if (item.kind === "trait") {
    item.declaration.typeParameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.constraint),
    );
    item.declaration.methods.forEach((method) => {
      method.signature.params.forEach((parameter) => {
        if (parameter.defaultValue) {
          throw new ParserSyntaxError(
            "trait methods do not support default parameters",
            parameter.defaultValue.location,
          );
        }
      });
      validateFunctionTypes(method);
      validateSurfaceExpression(method.body);
    });
    return;
  }
  if (item.kind === "impl") {
    item.declaration.typeParameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.constraint),
    );
    validateSurfaceTypeExpression(item.declaration.target);
    validateSurfaceTypeExpression(item.declaration.trait);
    item.declaration.methods.forEach((method) => {
      validateFunctionTypes(method);
      validateSurfaceExpression(method.body);
    });
    return;
  }
  if (item.kind === "type-alias") {
    item.declaration.typeParameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.constraint),
    );
    validateSurfaceTypeExpression(item.declaration.target);
    return;
  }
  if (item.kind === "object") {
    item.declaration.typeParameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.constraint),
    );
    validateSurfaceTypeExpression(item.declaration.base);
    item.declaration.fields.forEach((field) =>
      validateSurfaceTypeExpression(field.typeExpr),
    );
    return;
  }
  if (item.kind === "effect") {
    item.declaration.typeParameters.forEach((parameter) =>
      validateSurfaceTypeExpression(parameter.constraint),
    );
    item.declaration.operations.forEach((operation) => {
      operation.params.forEach((parameter) =>
        validateSurfaceTypeExpression(parameter.typeExpr),
      );
      validateSurfaceTypeExpression(operation.returnType);
    });
  }
};

const validateFunctionTypes = (
  declaration: ParsedFunctionDecl | ParsedTraitDecl["methods"][number],
): void => {
  declaration.signature.typeParameters.forEach((parameter) =>
    validateSurfaceTypeExpression(parameter.constraint),
  );
  declaration.signature.params.forEach((parameter) =>
    validateSurfaceTypeExpression(parameter.typeExpr),
  );
  declaration.signature.params.forEach((parameter) =>
    validateSurfaceExpression(parameter.defaultValue),
  );
  validateSurfaceTypeExpression(declaration.signature.effectType);
  validateSurfaceTypeExpression(declaration.signature.returnType);
};

const headerItemFor = (
  form: Form,
): ModuleHeaderView["items"][number] | undefined => {
  const classified = classifyTopLevelDecl(form);
  if (classified.kind === "use-decl") {
    return {
      kind: "use",
      form,
      visibility: classified.visibility,
      entries: parseUsePaths(classified.pathExpr, sourceSpanOf(form)),
    };
  }
  if (classified.kind === "inline-module-decl") {
    return { kind: "inline-module", form, declaration: classified };
  }
  if (classified.kind === "unsupported-mod-decl") {
    return { kind: "unsupported-module", form, declaration: classified };
  }
  if (classified.kind === "macro-decl") {
    return { kind: "macro", form, declaration: classified };
  }
  return undefined;
};

const parseOrdinaryDeclaration = (
  form: Form,
): SurfaceModuleItem | undefined => {
  const fn = parseFunctionDecl(form);
  if (fn) return { kind: "function", declaration: fn };
  const moduleLet = parseModuleLetDecl(form);
  if (moduleLet) return { kind: "module-let", declaration: moduleLet };
  const object = parseObjectDecl(form);
  if (object) return { kind: "object", declaration: object };
  const alias = parseTypeAliasDecl(form);
  if (alias) return { kind: "type-alias", declaration: alias };
  const trait = parseTraitDecl(form);
  if (trait) return { kind: "trait", declaration: trait };
  const impl = parseImplDecl(form);
  if (impl) return { kind: "impl", declaration: impl };
  const effect = parseEffectDecl(form);
  if (effect) return { kind: "effect", declaration: effect };
  return undefined;
};

const moduleEntries = (ast: Form): Form[] =>
  (formCallsInternal(ast, "ast") ? ast.rest : ast.toArray()).filter(
    (entry): entry is Form => isForm(entry) && entry.length > 0,
  );

export const sourceSpanOf = (syntax: Syntax): SourceSpan => ({
  file: syntax.location?.filePath ?? "<unknown>",
  start: syntax.location?.startIndex ?? 0,
  end: Math.max(
    (syntax.location?.startIndex ?? 0) + 1,
    syntax.location?.endIndex ?? 0,
  ),
});

const sourceSpanFromLocation = (
  location: NonNullable<ParserSyntaxError["location"]>,
): SourceSpan => ({
  file: location.filePath,
  start: location.startIndex,
  end: Math.max(location.startIndex + 1, location.endIndex),
});
