import {
  type Expr,
  type Syntax,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../parser/index.js";
import type { SymbolRecord } from "../binder/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { toSourceSpan } from "../utils.js";
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
    const labelKey = param.label ?? "";
    return {
      key: `${labelKey}:${annotation}`,
      label: `${displayName}: ${annotation}`,
    };
  });
  const returnAnnotation = formatTypeAnnotation(fn.returnTypeExpr);
  return {
    key: `${fn.params.length}|${params.map((param) => param.key).join(",")}`,
    label: `${fn.name}(${params
      .map((param) => param.label)
      .join(", ")}) -> ${returnAnnotation}`,
  };
};

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

const formatTypeAnnotation = (expr?: Expr): string => {
  if (!expr) {
    return "<inferred>";
  }
  if (isIdentifierAtom(expr)) {
    return expr.value;
  }
  if (isIntAtom(expr) || isFloatAtom(expr)) {
    return expr.value;
  }
  if (isStringAtom(expr)) {
    return JSON.stringify(expr.value);
  }
  if (isBoolAtom(expr)) {
    return String(expr.value);
  }
  if (isForm(expr)) {
    return `(${expr
      .toArray()
      .map((entry) => formatTypeAnnotation(entry))
      .join(" ")})`;
  }
  return "<expr>";
};

export const finalizeOverloadSets = (ctx: BindingContext): void => {
  let nextOverloadSetId = 0;
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
