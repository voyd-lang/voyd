import type { ScopeId } from "../ids.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import {
  formatTypeAnnotation,
  toSourceSpan,
} from "../../parser/surface/utils.js";
import type {
  BindingContext,
  BoundFunction,
  OverloadBucket,
  BoundParameter,
} from "./types.js";
import type { TypeParameterDecl } from "../decls.js";
import { findNonOverloadNameCollision } from "./name-collisions.js";

const makeOverloadBucketKey = (
  scope: ScopeId,
  name: string,
  bindingIdentity?: string,
): string => `${scope}:${bindingIdentity ?? "surface"}:${name}`;

export const recordFunctionOverload = (
  fn: BoundFunction,
  declarationScope: ScopeId,
  ctx: BindingContext,
): void => {
  const bindingIdentity = ctx.symbolTable.getSymbol(fn.symbol).bindingIdentity;
  const key = makeOverloadBucketKey(declarationScope, fn.name, bindingIdentity);
  let bucket = ctx.overloadBuckets.get(key);
  if (!bucket) {
    bucket = {
      scope: declarationScope,
      name: fn.name,
      functions: [],
      signatureIndex: new Map(),
      nonFunctionConflictReported: false,
    };
    ctx.overloadBuckets.set(key, bucket);
  }

  const signature = createOverloadSignature(fn);
  const duplicate = bucket.signatureIndex.get(signature.key);
  if (duplicate) {
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0002",
        span: toSourceSpan(fn.form),
        params: {
          kind: "duplicate-overload",
          functionName: fn.name,
          signature: signature.label,
        },
        related: [
          diagnosticFromCode({
            code: "BD0002",
            params: { kind: "previous-overload" },
            span: toSourceSpan(duplicate.form),
            severity: "note",
          }),
        ],
      }),
    );
  } else {
    bucket.signatureIndex.set(signature.key, fn);
  }

  bucket.functions.push(fn);

  const conflict = findNonOverloadNameCollision({
    name: fn.name,
    scope: declarationScope,
    skipSymbol: fn.symbol,
    bindingIdentity,
    ctx,
  });
  if (conflict && !bucket.nonFunctionConflictReported) {
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0003",
        params: {
          kind: "non-function-conflict",
          name: fn.name,
          conflictKind: conflict.kind,
        },
        span: toSourceSpan(fn.form),
        related: [
          diagnosticFromCode({
            code: "BD0003",
            params: { kind: "conflicting-declaration" },
            severity: "note",
            span: conflict.span,
          }),
        ],
      }),
    );
    bucket.nonFunctionConflictReported = true;
  }

  if (bucket.functions.length > 1) {
    ensureOverloadParameterAnnotations(bucket, ctx);
  }
};

const createOverloadSignature = (
  fn: BoundFunction,
): { key: string; label: string } => {
  const params = fn.params.map((param) => {
    const annotation = formatTypeAnnotation(param.typeExpr);
    const displayName = formatParameterDisplayName(param);
    const label = parameterLabel(param);
    const labelKey = label ?? "";
    return {
      key: `${labelKey}:${annotation}`,
      label: `${displayName}: ${annotation}`,
      displayLabel: label,
    };
  });
  const returnAnnotation = formatTypeAnnotation(fn.returnTypeExpr);
  const typeParameterConstraints = typeParameterConstraintKey(fn);
  const constraintLabel =
    typeParameterConstraints.length > 0
      ? ` where ${typeParameterConstraints}`
      : "";
  return {
    key: `${overloadSignatureKeyFromParams(fn.params, {
      includeLabels: true,
    })}|${typeParameterConstraints}`,
    label: `${fn.name}(${params
      .map((param) => param.label)
      .join(", ")}) -> ${returnAnnotation}${constraintLabel}`,
  };
};

const typeParameterConstraintKey = (fn: BoundFunction): string => {
  const params = fn.typeParameters ?? [];
  if (params.length === 0) {
    return "";
  }
  const signatureAnnotations = [
    ...fn.params.map((param) => formatTypeAnnotation(param.typeExpr)),
    formatTypeAnnotation(fn.returnTypeExpr),
  ];
  return params
    .filter((param) =>
      signatureAnnotations.some((annotation) =>
        referencesTypeParameter(annotation, param.name),
      ),
    )
    .map((param) => {
      const normalizedIndex = params.indexOf(param);
      return param.constraint
        ? normalizeTypeParameterNames(
            formatTypeAnnotation(param.constraint),
            params,
          )
        : `$${normalizedIndex}:_`;
    })
    .join(",");
};

const referencesTypeParameter = (annotation: string, name: string): boolean =>
  new RegExp(`\\b${escapeRegExp(name)}\\b`).test(annotation);

const normalizeTypeParameterNames = (
  value: string,
  params: readonly TypeParameterDecl[],
): string =>
  params.reduce(
    (out, param, index) =>
      out.replace(
        new RegExp(`\\b${escapeRegExp(param.name)}\\b`, "g"),
        `$${index}`,
      ),
    value,
  );

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parameterLabel = (param: BoundParameter): string | undefined =>
  param.label;

const formatParameterDisplayName = (param: BoundParameter): string => {
  if (!param.label) {
    return param.name;
  }
  if (param.label === param.name) {
    return param.label;
  }
  return `${param.label} ${param.name}`;
};

const ensureOverloadParameterAnnotations = (
  bucket: OverloadBucket,
  ctx: BindingContext,
): void => {
  const missingAnnotationSymbols = new Set<number>();
  bucket.functions.forEach((fn) => {
    fn.params.forEach((param) => {
      if (param.typeExpr) {
        return;
      }
      if (missingAnnotationSymbols.has(param.symbol)) {
        return;
      }
      const related = bucket.functions.find((candidate) => candidate !== fn);
      ctx.diagnostics.push(
        diagnosticFromCode({
          code: "BD0004",
          params: {
            kind: "missing-annotation",
            functionName: fn.name,
            parameter: param.name,
          },
          span: toSourceSpan(param.ast),
          related: related
            ? [
                diagnosticFromCode({
                  code: "BD0004",
                  params: { kind: "conflicting-overload" },
                  severity: "note",
                  span: toSourceSpan(related.form),
                }),
              ]
            : undefined,
        }),
      );
      missingAnnotationSymbols.add(param.symbol);
    });
  });
};

export const finalizeOverloadSets = (ctx: BindingContext): void => {
  const existingIds = [
    ...ctx.overloads.keys(),
    ...ctx.importedOverloadOptions.keys(),
  ];
  let nextOverloadSetId =
    existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
  for (const bucket of ctx.overloadBuckets.values()) {
    if (bucket.functions.length < 2) {
      continue;
    }
    const id = nextOverloadSetId++;
    const functions = [...bucket.functions];
    functions.forEach((fn) => {
      fn.overloadSetId = id;
      ctx.overloadBySymbol.set(fn.symbol, id);
    });
    ctx.overloads.set(id, {
      id,
      name: bucket.name,
      scope: bucket.scope,
      functions,
    });
  }
};

export const finalizeEffectOperationOverloadSets = (
  ctx: BindingContext,
): void => {
  const existingIds = [
    ...ctx.overloads.keys(),
    ...ctx.importedOverloadOptions.keys(),
  ];
  let nextOverloadSetId =
    existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
  ctx.decls.effects.forEach((effect) => {
    const byName = new Map<string, typeof effect.operations>();
    effect.operations.forEach((operation) => {
      byName.set(operation.name, [
        ...(byName.get(operation.name) ?? []),
        operation,
      ]);
    });
    byName.forEach((operations, name) => {
      if (operations.length < 2) return;
      const signatures = new Map<string, (typeof operations)[number]>();
      const missing = new Set<number>();
      operations.forEach((operation) => {
        const key = overloadSignatureKeyFromParams(operation.parameters);
        const previous = signatures.get(key);
        if (previous) {
          ctx.diagnostics.push(
            diagnosticFromCode({
              code: "BD0002",
              span: toSourceSpan(operation.ast),
              params: {
                kind: "duplicate-overload",
                functionName: `${effect.name}.${name}`,
                signature: `${effect.name}.${name}(${operation.parameters.map((param) => `${param.name}: ${formatTypeAnnotation(param.typeExpr)}`).join(", ")})`,
              },
              related: [
                diagnosticFromCode({
                  code: "BD0002",
                  params: { kind: "previous-overload" },
                  severity: "note",
                  span: toSourceSpan(previous.ast),
                }),
              ],
            }),
          );
        } else signatures.set(key, operation);
        operation.parameters.forEach((param) => {
          if (param.typeExpr || missing.has(param.symbol)) return;
          ctx.diagnostics.push(
            diagnosticFromCode({
              code: "BD0004",
              span: toSourceSpan(param.ast),
              params: {
                kind: "missing-annotation",
                functionName: `${effect.name}.${name}`,
                parameter: param.name,
              },
            }),
          );
          missing.add(param.symbol);
        });
      });
      const id = nextOverloadSetId++;
      const symbols = operations.map((operation) => operation.symbol);
      symbols.forEach((symbol) => ctx.overloadBySymbol.set(symbol, id));
      ctx.importedOverloadOptions.set(id, symbols);
    });
  });
};

const overloadSignatureKeyFromParams = (
  params: readonly BoundParameter[],
  options?: { includeLabels?: boolean },
): string => {
  const includeLabels = options?.includeLabels === true;
  const rendered = params.map((param) => {
    const annotation = formatTypeAnnotation(param.typeExpr);
    if (!includeLabels) {
      return annotation;
    }
    const label = parameterLabel(param);
    const labelKey = label ?? "";
    return `${labelKey}:${annotation}`;
  });
  return `${params.length}|${rendered.join(",")}`;
};
