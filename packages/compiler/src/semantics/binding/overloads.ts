import type { Syntax } from "../../parser/index.js";
import type { SymbolRecord } from "../binder/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { formatTypeAnnotation, toSourceSpan } from "../utils.js";
import type {
  BindingContext,
  BoundFunction,
  BoundOverloadSet,
  OverloadBucket,
  BoundParameter,
} from "./types.js";

const makeOverloadBucketKey = (scope: ScopeId, name: string): string =>
  `${scope}:${name}`;

export const recordFunctionOverload = (
  fn: BoundFunction,
  declarationScope: ScopeId,
  ctx: BindingContext
): void => {
  const key = makeOverloadBucketKey(declarationScope, fn.name);
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
      })
    );
  } else {
    bucket.signatureIndex.set(signature.key, fn);
  }

  bucket.functions.push(fn);

  const conflict = findNonFunctionDeclaration(
    fn.name,
    declarationScope,
    fn.symbol,
    ctx
  );
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
            span: spanForNode(conflict.declaredAt, ctx),
          }),
        ],
      })
    );
    bucket.nonFunctionConflictReported = true;
  }

  if (bucket.functions.length > 1) {
    ensureOverloadParameterAnnotations(bucket, ctx);
  }
};

const createOverloadSignature = (
  fn: BoundFunction
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
  return {
    key: overloadSignatureKeyFromParams(fn.params, { includeLabels: true }),
    label: `${fn.name}(${params
      .map((param) => param.label)
      .join(", ")}) -> ${returnAnnotation}`,
  };
};

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
  ctx: BindingContext
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
        })
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

export const finalizeEffectOperationOverloadSets = (ctx: BindingContext): void => {
  const existingIds = [
    ...ctx.overloads.keys(),
    ...ctx.importedOverloadOptions.keys(),
  ];
  let nextOverloadSetId =
    existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;

  ctx.decls.effects.forEach((effect) => {
    const operationsByName = new Map<string, typeof effect.operations>();
    effect.operations.forEach((op) => {
      const existing = operationsByName.get(op.name);
      if (existing) {
        operationsByName.set(op.name, [...existing, op]);
      } else {
        operationsByName.set(op.name, [op]);
      }
    });

    operationsByName.forEach((operations, opName) => {
      if (operations.length < 2) {
        return;
      }

      const signatureIndex = new Map<string, (typeof operations)[number]>();
      const missingAnnotationSymbols = new Set<number>();
      operations.forEach((op) => {
        const signatureKey = overloadSignatureKeyFromParams(op.parameters);
        const duplicate = signatureIndex.get(signatureKey);
        if (duplicate) {
          ctx.diagnostics.push(
            diagnosticFromCode({
              code: "BD0002",
              span: toSourceSpan(op.ast),
              params: {
                kind: "duplicate-overload",
                functionName: `${effect.name}.${opName}`,
                signature: `${effect.name}.${opName}(${op.parameters
                  .map((param) => `${param.name}: ${formatTypeAnnotation(param.typeExpr)}`)
                  .join(", ")})`,
              },
              related: [
                diagnosticFromCode({
                  code: "BD0002",
                  params: { kind: "previous-overload" },
                  span: toSourceSpan(duplicate.ast),
                  severity: "note",
                }),
              ],
            })
          );
        } else {
          signatureIndex.set(signatureKey, op);
        }

        op.parameters.forEach((param) => {
          if (param.typeExpr) {
            return;
          }
          if (missingAnnotationSymbols.has(param.symbol)) {
            return;
          }
          ctx.diagnostics.push(
            diagnosticFromCode({
              code: "BD0004",
              params: {
                kind: "missing-annotation",
                functionName: `${effect.name}.${opName}`,
                parameter: param.name,
              },
              span: toSourceSpan(param.ast),
            })
          );
          missingAnnotationSymbols.add(param.symbol);
        });
      });

      const id = nextOverloadSetId++;
      const symbols = operations.map((op) => op.symbol);
      symbols.forEach((symbol) => ctx.overloadBySymbol.set(symbol, id));
      ctx.importedOverloadOptions.set(id, symbols);
    });
  });
};

export const reportOverloadNameCollision = (
  name: string,
  scope: ScopeId,
  syntax: Syntax,
  ctx: BindingContext
): void => {
  const bucket = ctx.overloadBuckets.get(makeOverloadBucketKey(scope, name));
  if (
    !bucket ||
    bucket.functions.length === 0 ||
    bucket.nonFunctionConflictReported
  ) {
    return;
  }
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0003",
      params: { kind: "overload-name-collision", name },
      span: toSourceSpan(syntax),
      related: [
        diagnosticFromCode({
          code: "BD0003",
          params: { kind: "conflicting-declaration" },
          severity: "note",
          span: toSourceSpan(bucket.functions[0]!.form),
        }),
      ],
    })
  );
  bucket.nonFunctionConflictReported = true;
};

const spanForNode = (nodeId: NodeId, ctx: BindingContext) =>
  toSourceSpan(ctx.syntaxByNode.get(nodeId));

const findNonFunctionDeclaration = (
  name: string,
  scope: ScopeId,
  skipSymbol: SymbolId,
  ctx: BindingContext
): SymbolRecord | undefined => {
  for (const symbolId of ctx.symbolTable.symbolsInScope(scope)) {
    if (symbolId === skipSymbol) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(symbolId);
    if (record.name !== name) {
      continue;
    }
    const metadata = (record.metadata ?? {}) as { entity?: string };
    if (metadata.entity === "function" || metadata.entity === "object") {
      continue;
    }
    return record;
  }
  return undefined;
};
