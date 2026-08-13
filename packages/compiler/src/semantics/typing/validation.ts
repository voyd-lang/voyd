import type {
  HirExpression,
  HirGraph,
  HirItem,
  HirPattern,
  HirStatement,
  HirTypeExpr,
  HirTypeParameter,
} from "../hir/index.js";
import type { SourceSpan, TypeId, TypeParamId } from "../ids.js";
import { emitDiagnostic } from "../../diagnostics/index.js";
import { getSymbolName } from "./type-system.js";
import type { ObjectField, TypingContext } from "./types.js";

type TypeValidator = (typeId: TypeId, context: string) => void;

export const validateTypedProgram = (ctx: TypingContext): void => {
  const ensureKnownType = createTypeValidator(ctx);

  validateBorrowTypePositions(ctx);
  validateObjectTemplates(ctx, ensureKnownType);
  validateObjectInstances(ctx, ensureKnownType);
  validateTypeAliasInstances(ctx, ensureKnownType);
  validateTypeTable(ctx, ensureKnownType);
  validateValueTypes(ctx, ensureKnownType);
  validateHirTypeExprs(ctx.hir, ensureKnownType);
};

const validateBorrowTypePositions = (ctx: TypingContext): void => {
  validateBorrowTypeExprPositions(ctx);
  if (!ctx.arena.hasBorrowedTypes()) {
    return;
  }

  for (const [symbol, signature] of ctx.functions.signatures) {
    const record = ctx.symbolTable.getSymbol(symbol);
    const metadata = (record.metadata ?? {}) as {
      externalFunction?: unknown;
    };
    const context = `${record.name} signature`;
    const span =
      ctx.functions.getFunction(symbol)?.span ??
      signature.parameters[0]?.span ??
      ctx.hir.module.span;

    if (
      (record.kind === "effect-op" ||
        metadata.externalFunction !== undefined) &&
      signatureContainsBorrow(signature.typeId, ctx)
    ) {
      const boundary =
        record.kind === "effect-op" ? "effect operation" : "external function";
      emitDiagnostic({
        ctx,
        code: "TY0051",
        params: { kind: "borrow-signature-boundary", boundary },
        span,
      });
    }

    signature.parameters.forEach((parameter, index) =>
      validateBorrowType({
        type: parameter.type,
        allowBorrowRoot: true,
        context: `${context} parameter ${index + 1}`,
        ctx,
        span,
      }),
    );
    validateBorrowType({
      type: signature.returnType,
      allowBorrowRoot: false,
      context: `${context} return type`,
      ctx,
      span,
    });
    ensureBorrowCallableIsPure({
      parameters: signature.parameters.map((parameter) => parameter.type),
      effectRow: signature.effectRow,
      context,
      ctx,
      span,
    });
  }

  for (const template of ctx.objects.templates()) {
    template.fields.forEach((field) =>
      validateBorrowType({
        type: field.type,
        allowBorrowRoot: false,
        context: `object field ${field.name}`,
        ctx,
        span: ctx.hir.module.span,
      }),
    );
  }

  for (const [, instance] of ctx.objects.instanceEntries()) {
    instance.fields.forEach((field) =>
      validateBorrowType({
        type: field.type,
        allowBorrowRoot: false,
        context: `object field ${field.name}`,
        ctx,
        span: ctx.hir.module.span,
      }),
    );
  }

  const functionInstanceExprTypes = Array.from(
    ctx.functions.snapshotInstanceExprTypes().values(),
  );
  for (const expression of ctx.hir.expressions.values()) {
    if (expression.exprKind !== "lambda") continue;
    const lambdaTypes = new Set(
      [
        ctx.resolvedExprTypes.get(expression.id),
        ctx.borrowResolvedExprTypes.get(expression.id),
        ...functionInstanceExprTypes.map((types) => types.get(expression.id)),
      ].filter((type): type is TypeId => typeof type === "number"),
    );
    lambdaTypes.forEach((lambdaType) =>
      validateBorrowType({
        type: lambdaType,
        allowBorrowRoot: false,
        context: "lambda signature",
        ctx,
        span: expression.span,
      }),
    );
    const capturedBorrow = expression.captures.find(({ symbol }) => {
      const type = ctx.valueTypes.get(symbol);
      return typeof type === "number" && typeRootIsBorrowed(type, ctx);
    });
    if (capturedBorrow) {
      const name = ctx.symbolTable.getSymbol(capturedBorrow.symbol).name;
      emitDiagnostic({
        ctx,
        code: "TY0051",
        params: { kind: "borrow-capture", binding: name },
        span: expression.span,
      });
    }
  }

  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "module-let") continue;
    const type = ctx.valueTypes.get(item.symbol) ?? item.typeAnnotation?.typeId;
    if (typeof type === "number") {
      validateBorrowType({
        type,
        allowBorrowRoot: false,
        context: "module value",
        ctx,
        span: item.span,
      });
    }
  }
};

const validateBorrowTypeExprPositions = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind === "module-let") {
      validateBorrowTypeExprSyntax(
        item.typeAnnotation,
        false,
        "module value",
        ctx,
        item.span,
      );
    } else if (item.kind === "object") {
      item.fields.forEach((field) =>
        validateBorrowTypeExprSyntax(
          field.type,
          false,
          `object field ${field.name}`,
          ctx,
          item.span,
        ),
      );
    } else if (item.kind === "trait") {
      item.methods.forEach((method) => {
        method.parameters.forEach((parameter, index) =>
          validateBorrowTypeExprSyntax(
            parameter.type,
            true,
            `trait method parameter ${index + 1}`,
            ctx,
            method.span,
          ),
        );
        validateBorrowTypeExprSyntax(
          method.returnType,
          false,
          "trait method return type",
          ctx,
          method.span,
        );
      });
    } else if (item.kind === "effect") {
      item.operations.forEach((operation) => {
        operation.parameters.forEach((parameter) => {
          if (typeExprContainsBorrow(parameter.type)) {
            emitDiagnostic({
              ctx,
              code: "TY0051",
              params: {
                kind: "borrow-signature-boundary",
                boundary: "effect operation",
              },
              span: operation.span,
            });
          }
        });
        if (typeExprContainsBorrow(operation.returnType)) {
          emitDiagnostic({
            ctx,
            code: "TY0051",
            params: {
              kind: "borrow-signature-boundary",
              boundary: "effect operation",
            },
            span: operation.span,
          });
        }
      });
    }
  }
};

const validateBorrowType = ({
  type,
  allowBorrowRoot,
  context,
  ctx,
  span,
  seen = new Set<string>(),
}: {
  type: TypeId;
  allowBorrowRoot: boolean;
  context: string;
  ctx: TypingContext;
  span: SourceSpan;
  seen?: Set<string>;
}): void => {
  const seenKey = `${type}:${allowBorrowRoot ? "parameter" : "stored"}`;
  if (seen.has(seenKey)) {
    return;
  }
  seen.add(seenKey);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "borrowed":
      if (!allowBorrowRoot) {
        emitDiagnostic({
          ctx,
          code: "TY0051",
          params: { kind: "invalid-borrow-position", context },
          span,
        });
      }
      if (ctx.arena.get(desc.inner).kind === "borrowed") {
        emitDiagnostic({
          ctx,
          code: "TY0051",
          params: { kind: "nested-borrow" },
          span,
        });
      }
      validateBorrowType({
        type: desc.inner,
        allowBorrowRoot: false,
        context: `${context} inner type`,
        ctx,
        span,
        seen,
      });
      return;
    case "function":
      desc.parameters.forEach((parameter, index) =>
        validateBorrowType({
          type: parameter.type,
          allowBorrowRoot: true,
          context: `${context} nested callable parameter ${index + 1}`,
          ctx,
          span,
          seen,
        }),
      );
      validateBorrowType({
        type: desc.returnType,
        allowBorrowRoot: false,
        context: `${context} nested callable return type`,
        ctx,
        span,
        seen,
      });
      ensureBorrowCallableIsPure({
        parameters: desc.parameters.map((parameter) => parameter.type),
        effectRow: desc.effectRow,
        context: `${context} nested callable`,
        ctx,
        span,
      });
      return;
    case "recursive":
      validateBorrowType({
        type: desc.body,
        allowBorrowRoot,
        context,
        ctx,
        span,
        seen,
      });
      return;
    case "trait":
    case "nominal-object":
    case "value-object":
      desc.typeArgs.forEach((argument, index) =>
        validateBorrowType({
          type: argument,
          allowBorrowRoot: false,
          context: `${context} type argument ${index + 1}`,
          ctx,
          span,
          seen,
        }),
      );
      return;
    case "structural-object":
      desc.fields.forEach((field) =>
        validateBorrowType({
          type: field.type,
          allowBorrowRoot: false,
          context: `${context} field ${field.name}`,
          ctx,
          span,
          seen,
        }),
      );
      return;
    case "fixed-array":
      validateBorrowType({
        type: desc.element,
        allowBorrowRoot: false,
        context: `${context} element type`,
        ctx,
        span,
        seen,
      });
      return;
    case "union":
      desc.members.forEach((member, index) =>
        validateBorrowType({
          type: member,
          allowBorrowRoot: false,
          context: `${context} union member ${index + 1}`,
          ctx,
          span,
          seen,
        }),
      );
      return;
    case "intersection":
      [desc.nominal, desc.structural, ...(desc.traits ?? [])]
        .filter((member): member is TypeId => typeof member === "number")
        .forEach((member) =>
          validateBorrowType({
            type: member,
            allowBorrowRoot: false,
            context: `${context} intersection member`,
            ctx,
            span,
            seen,
          }),
        );
      return;
    case "primitive":
    case "type-param-ref":
      return;
  }
};

const ensureBorrowCallableIsPure = ({
  parameters,
  effectRow,
  context,
  ctx,
  span,
}: {
  parameters: readonly TypeId[];
  effectRow: number;
  context: string;
  ctx: TypingContext;
  span: SourceSpan;
}): void => {
  if (
    parameters.some((parameter) => typeRootIsBorrowed(parameter, ctx)) &&
    !ctx.effects.isEmpty(effectRow)
  ) {
    emitDiagnostic({
      ctx,
      code: "TY0051",
      params: { kind: "borrowed-callable-effect", context },
      span,
    });
  }
};

const typeRootIsBorrowed = (
  type: TypeId,
  ctx: TypingContext,
  seen = new Set<TypeId>(),
): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const desc = ctx.arena.get(type);
  return desc.kind === "borrowed"
    ? true
    : desc.kind === "recursive"
      ? typeRootIsBorrowed(desc.body, ctx, seen)
      : false;
};

const signatureContainsBorrow = (
  type: TypeId,
  ctx: TypingContext,
  seen = new Set<TypeId>(),
): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "borrowed":
      return true;
    case "recursive":
      return signatureContainsBorrow(desc.body, ctx, seen);
    case "function":
      return (
        desc.parameters.some((parameter) =>
          signatureContainsBorrow(parameter.type, ctx, seen),
        ) || signatureContainsBorrow(desc.returnType, ctx, seen)
      );
    case "trait":
    case "nominal-object":
    case "value-object":
      return desc.typeArgs.some((argument) =>
        signatureContainsBorrow(argument, ctx, seen),
      );
    case "structural-object":
      return desc.fields.some((field) =>
        signatureContainsBorrow(field.type, ctx, seen),
      );
    case "fixed-array":
      return signatureContainsBorrow(desc.element, ctx, seen);
    case "union":
      return desc.members.some((member) =>
        signatureContainsBorrow(member, ctx, seen),
      );
    case "intersection":
      return [desc.nominal, desc.structural, ...(desc.traits ?? [])]
        .filter((member): member is TypeId => typeof member === "number")
        .some((member) => signatureContainsBorrow(member, ctx, seen));
    case "primitive":
    case "type-param-ref":
      return false;
  }
};

const validateBorrowTypeExprSyntax = (
  expr: HirTypeExpr | undefined,
  allowBorrowRoot: boolean,
  context: string,
  ctx: TypingContext,
  span: SourceSpan,
): void => {
  if (!expr) return;
  if (expr.typeKind === "borrowed") {
    if (!allowBorrowRoot) {
      emitDiagnostic({
        ctx,
        code: "TY0051",
        params: { kind: "invalid-borrow-position", context },
        span,
      });
    }
    if (expr.inner.typeKind === "borrowed") {
      emitDiagnostic({
        ctx,
        code: "TY0051",
        params: { kind: "nested-borrow" },
        span,
      });
    }
    validateBorrowTypeExprSyntax(
      expr.inner,
      false,
      `${context} inner type`,
      ctx,
      span,
    );
    return;
  }
  if (expr.typeKind === "function") {
    expr.parameters.forEach((parameter, index) =>
      validateBorrowTypeExprSyntax(
        parameter.type,
        true,
        `${context} nested callable parameter ${index + 1}`,
        ctx,
        span,
      ),
    );
    validateBorrowTypeExprSyntax(
      expr.returnType,
      false,
      `${context} nested callable return type`,
      ctx,
      span,
    );
    return;
  }
  childTypeExprs(expr).forEach((child) =>
    validateBorrowTypeExprSyntax(child, false, context, ctx, span),
  );
};

const typeExprContainsBorrow = (expr: HirTypeExpr | undefined): boolean =>
  Boolean(
    expr &&
    (expr.typeKind === "borrowed" ||
      childTypeExprs(expr).some(typeExprContainsBorrow)),
  );

const childTypeExprs = (expr: HirTypeExpr): readonly HirTypeExpr[] => {
  switch (expr.typeKind) {
    case "borrowed":
      return [expr.inner];
    case "named":
      return expr.typeArguments ?? [];
    case "object":
      return expr.fields.map((field) => field.type);
    case "tuple":
      return expr.elements;
    case "union":
    case "intersection":
      return expr.members;
    case "function":
      return [
        ...expr.parameters.map((parameter) => parameter.type),
        expr.returnType,
      ];
    case "self":
      return [];
  }
};

const createTypeValidator = (ctx: TypingContext): TypeValidator => {
  const seen = new Set<TypeId>();

  const ensureKnownType = (typeId: TypeId, context: string): void => {
    if (typeId === ctx.primitives.unknown) {
      throw new Error(`unknown type remained after typing (${context})`);
    }

    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);

    const desc = ctx.arena.get(typeId);
    switch (desc.kind) {
      case "borrowed":
        ensureKnownType(desc.inner, `${context} borrowed inner type`);
        return;
      case "primitive":
        return;
      case "recursive":
        ensureKnownType(desc.body, `${context} recursive body`);
        return;
      case "trait":
      case "nominal-object":
      case "value-object":
        desc.typeArgs.forEach((arg, index) =>
          ensureKnownType(arg, `${context} type argument ${index + 1}`),
        );
        return;
      case "structural-object":
        desc.fields.forEach((field) =>
          ensureKnownType(field.type, `${context} field ${field.name}`),
        );
        return;
      case "function":
        desc.parameters.forEach((param, index) =>
          ensureKnownType(param.type, `${context} parameter ${index + 1}`),
        );
        ensureKnownType(desc.returnType, `${context} return type`);
        return;
      case "union":
        desc.members.forEach((member, index) =>
          ensureKnownType(member, `${context} union member ${index + 1}`),
        );
        return;
      case "intersection":
        if (typeof desc.nominal === "number") {
          ensureKnownType(desc.nominal, `${context} nominal component`);
        }
        if (typeof desc.structural === "number") {
          ensureKnownType(desc.structural, `${context} structural component`);
        }
        return;
      case "fixed-array":
        ensureKnownType(desc.element, `${context} element type`);
        return;
      case "type-param-ref":
        return;
      default: {
        const unreachable: never = desc;
        throw new Error(
          `unsupported type descriptor ${(unreachable as TypeId) ?? ""}`,
        );
      }
    }
  };

  return ensureKnownType;
};

const collectReferencedParams = (
  typeId: TypeId,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set(),
): Set<TypeParamId> => {
  if (seen.has(typeId)) {
    return new Set();
  }
  seen.add(typeId);

  const desc = ctx.arena.get(typeId);
  switch (desc.kind) {
    case "borrowed":
      return collectReferencedParams(desc.inner, ctx, seen);
    case "type-param-ref":
      return new Set([desc.param]);
    case "recursive": {
      const referenced = collectReferencedParams(desc.body, ctx, seen);
      referenced.delete(desc.binder);
      return referenced;
    }
    case "trait":
    case "nominal-object":
    case "value-object":
      return desc.typeArgs.reduce((acc, arg) => {
        collectReferencedParams(arg, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    case "structural-object":
      return desc.fields.reduce((acc, field) => {
        collectReferencedParams(field.type, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    case "function":
      return desc.parameters.reduce(
        (acc, param) => {
          collectReferencedParams(param.type, ctx, seen).forEach((entry) =>
            acc.add(entry),
          );
          return acc;
        },
        collectReferencedParams(desc.returnType, ctx, seen),
      );
    case "union":
      return desc.members.reduce((acc, member) => {
        collectReferencedParams(member, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    case "intersection": {
      const acc = new Set<TypeParamId>();
      if (typeof desc.nominal === "number") {
        collectReferencedParams(desc.nominal, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
      }
      if (typeof desc.structural === "number") {
        collectReferencedParams(desc.structural, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
      }
      return acc;
    }
    case "fixed-array":
      return collectReferencedParams(desc.element, ctx, seen);
    default:
      return new Set();
  }
};

const referencedTemplateParams = (
  field: ObjectField,
  templateParams: ReadonlySet<TypeParamId>,
  ctx: TypingContext,
): Set<TypeParamId> =>
  new Set(
    Array.from(collectReferencedParams(field.type, ctx)).filter((param) =>
      templateParams.has(param),
    ),
  );

const ensureFieldsSubstituted = ({
  fields,
  ctx,
  context,
  templateParams,
  requireSubstitution,
  validateType,
}: {
  fields: readonly ObjectField[];
  ctx: TypingContext;
  context: string;
  templateParams?: ReadonlySet<TypeParamId>;
  requireSubstitution: boolean;
  validateType: TypeValidator;
}): void => {
  fields.forEach((field) => {
    validateType(field.type, `${context} field ${field.name}`);
    if (!field.declaringParams?.length) {
      return;
    }

    if (!requireSubstitution && templateParams) {
      const remaining = referencedTemplateParams(field, templateParams, ctx);
      const declared = new Set(field.declaringParams);
      const missing = Array.from(remaining).filter(
        (param) => !declared.has(param),
      );
      if (missing.length > 0) {
        throw new Error(
          `${context} field ${field.name} is missing declaring params for structural type variables`,
        );
      }
      return;
    }

    const declaredParams = new Set(field.declaringParams);
    const remaining = collectReferencedParams(field.type, ctx);
    const unsubstituted = Array.from(remaining).filter((param) =>
      declaredParams.has(param),
    );
    if (requireSubstitution && unsubstituted.length > 0) {
      throw new Error(
        `${context} is missing substitutions for field ${field.name}`,
      );
    }
  });
};

const validateObjectTemplates = (
  ctx: TypingContext,
  validateType: TypeValidator,
): void => {
  for (const template of ctx.objects.templates()) {
    const declaredParams = new Set(
      template.params.map((param) => param.typeParam),
    );
    const context = `object template ${getSymbolName(template.symbol, ctx)}`;
    validateType(template.type, context);
    validateType(template.structural, `${context} structural type`);
    validateType(template.nominal, `${context} nominal type`);
    ensureFieldsSubstituted({
      fields: template.fields,
      ctx,
      context,
      templateParams: declaredParams,
      requireSubstitution: false,
      validateType,
    });
  }
};

const parseInstanceKey = (
  key: string,
): { symbol?: number; typeArgs: readonly number[] } => {
  const [symbolText, argsText] = key.split("<");
  const symbol = Number(symbolText);
  const typeArgs = argsText?.endsWith(">")
    ? argsText.slice(0, -1).split(",").filter(Boolean).map(Number)
    : [];
  return {
    symbol: Number.isNaN(symbol) ? undefined : symbol,
    typeArgs,
  };
};

const validateObjectInstances = (
  ctx: TypingContext,
  validateType: TypeValidator,
): void => {
  for (const [key, info] of ctx.objects.instanceEntries()) {
    const parsed = parseInstanceKey(key);
    const template =
      typeof parsed.symbol === "number"
        ? ctx.objects.getTemplate(parsed.symbol)
        : undefined;
    const templateParams = template
      ? new Set(template.params.map((param) => param.typeParam))
      : undefined;
    const name =
      typeof parsed.symbol === "number"
        ? getSymbolName(parsed.symbol, ctx)
        : key;
    const context = `object instance ${name}`;

    validateType(info.type, context);
    validateType(info.structural, `${context} structural type`);
    validateType(info.nominal, `${context} nominal type`);
    ensureFieldsSubstituted({
      fields: info.fields,
      ctx,
      context,
      templateParams,
      requireSubstitution: true,
      validateType,
    });
  }
};

const validateTypeAliasInstances = (
  ctx: TypingContext,
  validateType: TypeValidator,
): void => {
  const substitutionSeen = new Set<TypeId>();
  for (const [key, instance] of ctx.typeAliases.instanceEntries()) {
    const { typeArgs } = parseInstanceKey(key);
    const hasGenericArgs = typeArgs.some((arg) => {
      const desc = ctx.arena.get(arg);
      return desc.kind === "type-param-ref";
    });

    const context = `type alias instance ${key}`;
    validateType(instance, context);
    if (hasGenericArgs) {
      continue;
    }
    enforceStructuralSubstitution(instance, ctx, context, substitutionSeen);
  }
};

const enforceStructuralSubstitution = (
  typeId: TypeId,
  ctx: TypingContext,
  context: string,
  seen: Set<TypeId>,
): void => {
  if (seen.has(typeId)) {
    return;
  }
  seen.add(typeId);

  const desc = ctx.arena.get(typeId);
  switch (desc.kind) {
    case "borrowed":
      enforceStructuralSubstitution(desc.inner, ctx, context, seen);
      return;
    case "recursive":
      enforceStructuralSubstitution(desc.body, ctx, context, seen);
      return;
    case "structural-object": {
      desc.fields.forEach((field) => {
        if (!field.declaringParams?.length) {
          enforceStructuralSubstitution(field.type, ctx, context, seen);
          return;
        }
        const remaining = collectReferencedParams(field.type, ctx);
        const declared = new Set(field.declaringParams);
        const unsubstituted = Array.from(remaining).filter((param) =>
          declared.has(param),
        );
        if (unsubstituted.length > 0) {
          throw new Error(
            `${context} still has unsubstituted structural fields`,
          );
        }
        enforceStructuralSubstitution(field.type, ctx, context, seen);
      });
      return;
    }
    case "trait":
    case "nominal-object":
    case "value-object":
      desc.typeArgs.forEach((arg) =>
        enforceStructuralSubstitution(arg, ctx, context, seen),
      );
      return;
    case "function":
      desc.parameters.forEach((param) =>
        enforceStructuralSubstitution(param.type, ctx, context, seen),
      );
      enforceStructuralSubstitution(desc.returnType, ctx, context, seen);
      return;
    case "union":
      desc.members.forEach((member) =>
        enforceStructuralSubstitution(member, ctx, context, seen),
      );
      return;
    case "intersection":
      if (typeof desc.nominal === "number") {
        enforceStructuralSubstitution(desc.nominal, ctx, context, seen);
      }
      if (typeof desc.structural === "number") {
        enforceStructuralSubstitution(desc.structural, ctx, context, seen);
      }
      return;
    case "fixed-array":
      enforceStructuralSubstitution(desc.element, ctx, context, seen);
      return;
    case "primitive":
    case "type-param-ref":
      return;
    default: {
      const unreachable: never = desc;
      throw new Error(
        `unsupported type descriptor ${(unreachable as TypeId) ?? ""}`,
      );
    }
  }
};

const validateTypeTable = (
  ctx: TypingContext,
  validateType: TypeValidator,
): void => {
  for (const [exprId, typeId] of ctx.table.entries()) {
    const expr = ctx.hir.expressions.get(exprId);
    const context = expr
      ? `expression ${exprId} (${expr.exprKind})`
      : `expression ${exprId}`;
    validateType(typeId, context);
  }
};

const validateValueTypes = (
  ctx: TypingContext,
  validateType: TypeValidator,
): void => {
  for (const [symbol, typeId] of ctx.valueTypes.entries()) {
    validateType(typeId, `value ${getSymbolName(symbol, ctx)}`);
  }
};

const validateHirTypeExprs = (
  hir: HirGraph,
  validateType: TypeValidator,
): void => {
  for (const item of hir.items.values()) {
    validateItemTypeExprs(item, validateType);
  }

  for (const stmt of hir.statements.values()) {
    validateStatementTypeExprs(stmt, validateType);
  }

  for (const expr of hir.expressions.values()) {
    validateExpressionTypeExprs(expr, validateType);
  }
};

const validateItemTypeExprs = (
  item: HirItem,
  validateType: TypeValidator,
): void => {
  switch (item.kind) {
    case "function":
      visitTypeParameters(item.typeParameters, validateType);
      item.parameters.forEach((param) =>
        visitTypeExpr(
          param.type,
          validateType,
          `function parameter ${param.symbol}`,
        ),
      );
      visitTypeExpr(
        item.returnType,
        validateType,
        `function ${item.symbol} return type`,
      );
      visitTypeExpr(
        item.effectType,
        validateType,
        `function ${item.symbol} effect type`,
      );
      return;
    case "type-alias":
      visitTypeParameters(item.typeParameters, validateType);
      visitTypeExpr(
        item.target,
        validateType,
        `type alias ${item.symbol} target`,
      );
      return;
    case "object":
      visitTypeParameters(item.typeParameters, validateType);
      visitTypeExpr(item.base, validateType, `object ${item.symbol} base`);
      item.fields.forEach((field) =>
        visitTypeExpr(field.type, validateType, `object field ${field.name}`),
      );
      return;
    case "trait":
      visitTypeParameters(item.typeParameters, validateType);
      item.requirements?.forEach((req, index) =>
        visitTypeExpr(req, validateType, `trait requirement ${index + 1}`),
      );
      item.methods.forEach((method) => {
        visitTypeParameters(method.typeParameters, validateType);
        method.parameters.forEach((param) =>
          visitTypeExpr(
            param.type,
            validateType,
            `trait method parameter ${param.symbol}`,
          ),
        );
        visitTypeExpr(
          method.returnType,
          validateType,
          `trait method ${method.symbol} return type`,
        );
      });
      return;
    case "impl":
      visitTypeParameters(item.typeParameters, validateType);
      visitTypeExpr(item.target, validateType, `impl target ${item.symbol}`);
      visitTypeExpr(item.trait, validateType, `impl trait ${item.symbol}`);
      item.with?.forEach((entry) => {
        if (entry.kind === "member-import") {
          visitTypeExpr(
            entry.source,
            validateType,
            `impl member source ${item.symbol}`,
          );
          return;
        }
        visitTypeExpr(
          entry.source,
          validateType,
          `impl trait source ${item.symbol}`,
        );
        visitTypeExpr(
          entry.trait,
          validateType,
          `impl trait import ${item.symbol}`,
        );
      });
      return;
    case "effect":
      visitTypeParameters(item.typeParameters, validateType);
      item.operations.forEach((op) => {
        op.parameters.forEach((param) =>
          visitTypeExpr(
            param.type,
            validateType,
            `effect parameter ${param.symbol}`,
          ),
        );
        visitTypeExpr(
          op.returnType,
          validateType,
          `effect return type ${op.symbol}`,
        );
      });
      return;
    default:
      return;
  }
};

const visitTypeParameters = (
  params: readonly HirTypeParameter[] | undefined,
  validateType: TypeValidator,
): void => {
  params?.forEach((param) => {
    visitTypeExpr(
      param.constraint,
      validateType,
      `type parameter constraint ${param.symbol}`,
    );
    visitTypeExpr(
      param.defaultType,
      validateType,
      `type parameter default ${param.symbol}`,
    );
  });
};

const validateStatementTypeExprs = (
  stmt: HirStatement,
  validateType: TypeValidator,
): void => {
  if (stmt.kind === "let") {
    visitPattern(stmt.pattern, validateType);
  }
};

const validateExpressionTypeExprs = (
  expr: HirExpression,
  validateType: TypeValidator,
): void => {
  switch (expr.exprKind) {
    case "call":
      expr.typeArguments?.forEach((arg, index) =>
        visitTypeExpr(arg, validateType, `call type argument ${index + 1}`),
      );
      expr.targetTypeArguments?.forEach((arg, index) =>
        visitTypeExpr(
          arg,
          validateType,
          `call target type argument ${index + 1}`,
        ),
      );
      return;
    case "method-call":
      expr.typeArguments?.forEach((arg, index) =>
        visitTypeExpr(
          arg,
          validateType,
          `method call type argument ${index + 1}`,
        ),
      );
      return;
    case "lambda":
      visitTypeParameters(expr.typeParameters, validateType);
      expr.parameters.forEach((param) =>
        visitTypeExpr(
          param.type,
          validateType,
          `lambda parameter ${param.symbol}`,
        ),
      );
      visitTypeExpr(
        expr.returnType,
        validateType,
        `lambda return type ${expr.id}`,
      );
      visitTypeExpr(
        expr.effectType,
        validateType,
        `lambda effect type ${expr.id}`,
      );
      return;
    case "match":
      expr.arms.forEach((arm, index) =>
        visitPattern(arm.pattern, validateType, `match arm ${index + 1}`),
      );
      return;
    case "object-literal":
      visitTypeExpr(
        expr.target,
        validateType,
        `object literal target ${expr.id}`,
      );
      return;
    default:
      return;
  }
};

const visitPattern = (
  pattern: HirPattern,
  validateType: TypeValidator,
  context?: string,
): void => {
  if (pattern.kind === "type") {
    visitTypeExpr(pattern.type, validateType, context ?? "type pattern");
  }
  if (pattern.kind === "destructure") {
    pattern.fields.forEach((field) =>
      visitPattern(field.pattern, validateType),
    );
    if (pattern.spread) {
      visitPattern(pattern.spread, validateType);
    }
  }
  if (pattern.kind === "tuple") {
    pattern.elements.forEach((element) => visitPattern(element, validateType));
  }
};

const visitTypeExpr = (
  expr: HirTypeExpr | undefined,
  validateType: TypeValidator,
  context: string,
): void => {
  if (!expr) {
    return;
  }
  if (typeof expr.typeId === "number") {
    validateType(expr.typeId, context);
  }

  switch (expr.typeKind) {
    case "borrowed":
      visitTypeExpr(expr.inner, validateType, `${context} borrowed inner type`);
      return;
    case "named":
      expr.typeArguments?.forEach((arg, index) =>
        visitTypeExpr(
          arg,
          validateType,
          `${context} type argument ${index + 1}`,
        ),
      );
      return;
    case "object":
      expr.fields.forEach((field) =>
        visitTypeExpr(
          field.type,
          validateType,
          `${context} field ${field.name}`,
        ),
      );
      return;
    case "tuple":
      expr.elements.forEach((element, index) =>
        visitTypeExpr(element, validateType, `${context} element ${index + 1}`),
      );
      return;
    case "union":
    case "intersection":
      expr.members.forEach((member, index) =>
        visitTypeExpr(member, validateType, `${context} member ${index + 1}`),
      );
      return;
    case "function":
      visitTypeParameters(expr.typeParameters, validateType);
      expr.parameters.forEach((param, index) =>
        visitTypeExpr(
          param.type,
          validateType,
          `${context} parameter ${index + 1}`,
        ),
      );
      visitTypeExpr(expr.returnType, validateType, `${context} return type`);
      visitTypeExpr(expr.effectType, validateType, `${context} effect type`);
      return;
    case "self":
      return;
    default:
      return;
  }
};
