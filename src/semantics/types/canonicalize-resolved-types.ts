import { Expr } from "../../syntax-objects/expr.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Variable } from "../../syntax-objects/variable.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Closure } from "../../syntax-objects/closure.js";
import { VoydModule } from "../../syntax-objects/module.js";
import {
  ObjectLiteral,
  ObjectLiteralField,
} from "../../syntax-objects/object-literal.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { Macro } from "../../syntax-objects/macros.js";
import { MacroLambda } from "../../syntax-objects/macro-lambda.js";
import { MacroVariable } from "../../syntax-objects/macro-variable.js";
import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
  VoydRefType,
} from "../../syntax-objects/types.js";
import {
  CanonicalTypeTable,
  type CanonicalTypeDedupeEvent,
} from "./canonical-type-table.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import { assertCanonicalTypeRef } from "./debug/assert-canonical-type-ref.js";
import { reconcileGenericInstances } from "./reconcile-generic-instances.js";

type CanonicalizeCtx = {
  table: CanonicalTypeTable;
  visitedExpr: Set<Expr>;
  visitedTypes: Set<Type>;
  requiresRevisit: boolean;
};

const SOME_CONSTRUCTOR_NAME = "Some";
const NONE_CONSTRUCTOR_NAME = "None";

const CANON_DEBUG = Boolean(process.env.CANON_DEBUG);
const CANON_TRACE_RECONCILE = Boolean(process.env.CANON_TRACE_RECONCILE);

const matchesName = (value: unknown, expected: string): boolean => {
  if (!value) return false;
  if (typeof value === "string") return value === expected;
  if (typeof value === "object") {
    const candidate = value as {
      is?: (input: string) => boolean;
      toString?: () => string;
      value?: string;
    };
    if (typeof candidate.is === "function") {
      return candidate.is(expected);
    }
    if (typeof candidate.value === "string") {
      return candidate.value === expected;
    }
    if (typeof candidate.toString === "function") {
      return candidate.toString() === expected;
    }
  }
  return false;
};

const isOptionalSomeConstructor = (
  obj: ObjectType | undefined
): obj is ObjectType =>
  !!obj &&
  (matchesName(obj.name, SOME_CONSTRUCTOR_NAME) ||
    matchesName(obj.genericParent?.name, SOME_CONSTRUCTOR_NAME));

const isOptionalNoneConstructor = (
  obj: ObjectType | undefined
): obj is ObjectType =>
  !!obj &&
  (matchesName(obj.name, NONE_CONSTRUCTOR_NAME) ||
    matchesName(obj.genericParent?.name, NONE_CONSTRUCTOR_NAME));

const isOptionalConstructor = (
  obj: ObjectType | undefined
): obj is ObjectType =>
  isOptionalSomeConstructor(obj) || isOptionalNoneConstructor(obj);

const unionHasOptionalConstructors = (union: UnionType): boolean =>
  union.types.some(
    (candidate) =>
      (candidate as ObjectType).isObjectType?.() &&
      isOptionalConstructor(candidate as ObjectType)
  );

const dedupeByRef = <T>(values: T[]): T[] => {
  const seen = new Set<T>();
  const result: T[] = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
};

const isVoydRefType = (value: Type | undefined): value is VoydRefType =>
  !!value?.isRefType?.();

const getOptionalBaseId = (obj: ObjectType): string | undefined => {
  const id = obj.id ?? obj.name?.toString?.();
  if (!id) return undefined;
  const parts = id.split("#");
  if (parts.length <= 2) return undefined;
  return `${parts[0]}#${parts[1]}`;
};

const formatTypeId = (type: ObjectType | undefined): string => {
  if (!type) return "<unknown>";
  return type.id ?? type.name?.toString?.() ?? "<anonymous object>";
};

const formatTypeRef = (type: Type | undefined): string => {
  if (!type) return "<unknown>";
  if ((type as ObjectType).isObjectType?.()) {
    return formatTypeId(type as ObjectType);
  }
  const id = (type as any).id;
  if (typeof id === "string" && id.length) return id;
  const name = (type as any).name?.toString?.();
  if (typeof name === "string" && name.length) return name;
  const kind = (type as any).kindOfType;
  if (typeof kind === "string" && kind.length) return `<${kind}>`;
  const ctor = (type as any).constructor?.name;
  return typeof ctor === "string" && ctor.length ? ctor : "<Type>";
};

const describeSyntaxNode = (node: Expr | undefined): string | undefined => {
  if (!node) return undefined;
  const base = node as any;
  const label = base.syntaxType ?? base.constructor?.name ?? "<unknown>";
  const identifier =
    (base.name && base.name.toString?.()) ??
    base.id ??
    (typeof base.syntaxId === "number" ? `#${base.syntaxId}` : undefined);
  const entry = identifier ? `${label}(${identifier})` : label;
  const location = base.location?.toString?.();
  return location ? `${entry}@${location}` : entry;
};

const traceSyntaxChain = (start: Expr | undefined, limit = 5): string[] => {
  const chain: string[] = [];
  let current: Expr | undefined = start;
  while (current && chain.length < limit) {
    const label = describeSyntaxNode(current);
    if (label) chain.push(label);
    current = current.parent;
  }
  return chain;
};

const buildOrphanSnapshot = (
  ctx: CanonicalizeCtx,
  instance: ObjectType
): {
  id: string;
  syntaxId: number;
  location?: string;
  key: string;
  genericParent?: string;
  appliedArgs: string[];
  parentChain: string[];
} => ({
  id: formatTypeId(instance),
  syntaxId: instance.syntaxId,
  location: instance.location?.toString(),
  key: getInstanceKey(ctx, instance),
  genericParent: formatTypeId(instance.genericParent as ObjectType | undefined),
  appliedArgs: (instance.appliedTypeArgs ?? []).map((arg) =>
    formatTypeRef(arg)
  ),
  parentChain: traceSyntaxChain(instance.parent as Expr | undefined),
});

type OrphanDiagnosticsRecord = {
  parent: string;
  key: string;
  orphan: ReturnType<typeof buildOrphanSnapshot>;
  canonical: ReturnType<typeof buildOrphanSnapshot>;
};

const ORPHAN_LOG_ATTR = "canon:orphanLog";

const recordOrphanDiagnostics = (
  ctx: CanonicalizeCtx,
  parent: ObjectType,
  orphan: ObjectType,
  canonical: ObjectType
): OrphanDiagnosticsRecord => {
  const record: OrphanDiagnosticsRecord = {
    parent: formatTypeId(parent),
    key: getInstanceKey(ctx, canonical),
    orphan: buildOrphanSnapshot(ctx, orphan),
    canonical: buildOrphanSnapshot(ctx, canonical),
  };

  if (typeof orphan.setAttribute === "function") {
    orphan.setAttribute("canon:orphanSnapshot", record);
  }
  if (typeof canonical.setAttribute === "function") {
    canonical.setAttribute("canon:canonicalSnapshot", record);
  }
  if (
    typeof parent.setAttribute === "function" &&
    typeof parent.getAttribute === "function"
  ) {
    const existing =
      (parent.getAttribute(ORPHAN_LOG_ATTR) as OrphanDiagnosticsRecord[] | undefined) ??
      [];
    parent.setAttribute(ORPHAN_LOG_ATTR, [
      ...existing.slice(-9),
      record,
    ]);
  }

  return record;
};

const adoptObjectMetadata = (
  target: ObjectType,
  source: ObjectType
): void => {
  if (source.typesResolved === true && target.typesResolved !== true) {
    target.typesResolved = true;
  }

  if (source.binaryenType !== undefined) {
    target.binaryenType = source.binaryenType;
  }

  const sourceBinaryenAttr = source.getAttribute?.("binaryenType");
  if (sourceBinaryenAttr !== undefined) {
    target.setAttribute?.("binaryenType", sourceBinaryenAttr);
  }

  const sourceOriginalAttr = source.getAttribute?.("originalType");
  if (sourceOriginalAttr !== undefined) {
    target.setAttribute?.("originalType", sourceOriginalAttr);
  }
};

const debugCheckParentRegistration = (
  instance: ObjectType,
  canonicalInstance: ObjectType,
  canonicalParent: ObjectType
): void => {
  if (!CANON_DEBUG) return;

  const parentChildren = canonicalParent.genericInstances ?? [];
  const isRegistered = parentChildren.includes(canonicalInstance);
  const canonicalParentMismatch =
    canonicalInstance.genericParent && canonicalInstance.genericParent !== canonicalParent;
  const instanceParentMismatch =
    instance.genericParent && instance.genericParent !== canonicalParent;

  if (!isRegistered || canonicalParentMismatch || instanceParentMismatch) {
    const payload = {
      canonicalParent: formatTypeId(canonicalParent),
      canonicalInstance: formatTypeId(canonicalInstance),
      instance: formatTypeId(instance),
      canonicalInstanceParent: formatTypeId(
        canonicalInstance.genericParent as ObjectType | undefined
      ),
      instanceParent: formatTypeId(instance.genericParent as ObjectType | undefined),
      registeredChildren: parentChildren.map((child) =>
        formatTypeId(child as ObjectType | undefined)
      ),
    };

    console.warn(`[CANON_DEBUG] orphaned generic instance detected`, payload);
  }
};

const canonicalizeTypeViaTable = (
  ctx: CanonicalizeCtx,
  type?: Type
): Type | undefined => {
  if (!type) return undefined;
  const canonicalized = ctx.table.canonicalize(type);
  const canonical = ctx.table.getCanonical(canonicalized);
  return canonical ?? canonicalized;
};

const canonicalArgKeyCache = new WeakMap<Type, string>();
let canonicalArgKeyCounter = 0;

const getAppliedArgKey = (ctx: CanonicalizeCtx, type?: Type): string => {
  if (!type) return "∅";
  const canonical = canonicalizeTypeViaTable(ctx, type) ?? type;
  if (canonicalArgKeyCache.has(canonical)) {
    return canonicalArgKeyCache.get(canonical)!;
  }
  const id =
    ((canonical as any).id as string | undefined) ??
    (canonical as any).name?.toString?.() ??
    `type#${canonicalArgKeyCounter++}`;
  canonicalArgKeyCache.set(canonical, id);
  return id;
};

const getInstanceKey = (ctx: CanonicalizeCtx, instance: ObjectType): string => {
  const args = instance.appliedTypeArgs ?? [];
  if (!args.length) return "[]";
  const parts = args.map((arg) => getAppliedArgKey(ctx, arg));
  return `[${parts.join(",")}]`;
};

const findCanonicalParentInstance = (
  ctx: CanonicalizeCtx,
  instance: ObjectType
): ObjectType | undefined => {
  const canonicalInstance =
    resolveCanonicalObject(ctx, instance) ?? instance;
  const parent = canonicalInstance.genericParent as ObjectType | undefined;
  if (!parent?.genericInstances?.length) return undefined;
  const targetKey = getInstanceKey(ctx, canonicalInstance);
  const siblings = parent.genericInstances;
  for (let index = 0; index < siblings.length; index += 1) {
    const candidate = siblings[index];
    if (!candidate) continue;
    const canonicalCandidate =
      resolveCanonicalObject(ctx, candidate) ?? candidate;
    if (canonicalCandidate !== candidate) {
      siblings[index] = canonicalCandidate;
    }
    if (canonicalCandidate === canonicalInstance) {
      return canonicalCandidate;
    }
    if (candidate === canonicalInstance) {
      return canonicalCandidate;
    }
    if (getInstanceKey(ctx, canonicalCandidate) === targetKey) {
      return canonicalCandidate;
    }
  }
  return undefined;
};

const clearTypeCaches = (type: Type, canonical: Type): void => {
  if (type === canonical) return;

  type.setAttribute?.("binaryenType", undefined);
  type.setAttribute?.("originalType", undefined);

  if ((type as ObjectType).isObjectType?.()) {
    const obj = type as ObjectType;
    obj.binaryenType = undefined;
  }

  if ((type as FixedArrayType).isFixedArrayType?.()) {
    const arr = type as FixedArrayType;
    arr.binaryenType = undefined;
  }
};

const dedupeImplementations = (
  impls: Implementation[] | undefined
): Implementation[] | undefined => {
  if (!impls?.length) return impls;
  const seen = new Set<string>();
  const result: Implementation[] = [];
  impls.forEach((impl) => {
    const key = impl.trait
      ? `trait:${impl.trait.id}`
      : `inherent:${impl.syntaxId}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(impl);
  });
  return result;
};

const resolveCanonicalObject = (
  ctx: CanonicalizeCtx,
  candidate?: ObjectType
): ObjectType | undefined => {
  if (!candidate) return undefined;
  const resolved = canonicalizeTypeViaTable(ctx, candidate) as
    | ObjectType
    | undefined;
  if (!resolved || !(resolved as ObjectType).isObjectType?.()) return undefined;
  const canonical = resolved as ObjectType;
  if (canonical.appliedTypeArgs?.length) {
    const canonicalArgs = canonical.appliedTypeArgs
      .map((arg) => canonicalizeTypeViaTable(ctx, arg))
      .filter((arg): arg is Type => !!arg);
    canonical.appliedTypeArgs = canonicalArgs;
    if (candidate !== canonical) {
      candidate.appliedTypeArgs = [...canonicalArgs];
    }
  }
  if (candidate !== canonical) {
    adoptObjectMetadata(canonical, candidate);
    clearTypeCaches(candidate, canonical);
  }
  return canonical;
};

const reconcileObjectGenericInstances = (
  ctx: CanonicalizeCtx,
  parent: ObjectType,
  extraCandidates: ObjectType[] = []
): void => {
  const canonicalParent = resolveCanonicalObject(ctx, parent);
  if (!canonicalParent) return;

  const baseline = canonicalParent.genericInstances ?? [];
  const candidates = [...baseline, ...extraCandidates];
  if (!candidates.length) {
    canonicalParent.genericInstances = [];
    return;
  }

  const canonicalByOriginal = new Map<ObjectType, ObjectType>();
  const normalizedCandidates: ObjectType[] = [];

  candidates.forEach((candidate) => {
    if (!candidate) return;
    const canonicalInstance = resolveCanonicalObject(ctx, candidate);
    if (!canonicalInstance || !canonicalInstance.isObjectType?.()) return;
    canonicalByOriginal.set(candidate, canonicalInstance);
    normalizedCandidates.push(candidate);
  });

  if (CANON_TRACE_RECONCILE) {
    console.log("[CANON_TRACE_RECONCILE] reconcileObjectGenericInstances", {
      parent: formatTypeId(canonicalParent),
      candidates: normalizedCandidates.map((instance) => {
        const canonicalInstance = canonicalByOriginal.get(instance) ?? instance;
        return {
          id: formatTypeId(instance),
          canonical: formatTypeId(canonicalInstance),
          key: getInstanceKey(ctx, canonicalInstance),
          isCanonical: canonicalInstance === instance,
        };
      }),
    });
  }

  const { canonicalInstances, orphans } = reconcileGenericInstances(
    canonicalParent,
    normalizedCandidates,
    {
      canonicalizeType: (type) => canonicalizeTypeViaTable(ctx, type),
      resolveCanonicalInstance: (instance) =>
        canonicalByOriginal.get(instance) ?? resolveCanonicalObject(ctx, instance),
    }
  );

  if (orphans.length) {
    ctx.requiresRevisit = true;
  }

  orphans.forEach(({ orphan, canonical }) => {
    ctx.table.registerAlias(orphan, canonical);
    clearTypeCaches(orphan, canonical);
    orphan.genericInstances = [];
    orphan.genericParent = canonical.genericParent ?? canonicalParent;
    const record = recordOrphanDiagnostics(
      ctx,
      canonicalParent,
      orphan,
      canonical
    );
    if (CANON_DEBUG) {
      console.warn(
        `[CANON_DEBUG] reconcileObjectGenericInstances dropped orphan`,
        record
      );
    }
    if (CANON_TRACE_RECONCILE) {
      console.log("[CANON_TRACE_RECONCILE] orphan", {
        orphan: record.orphan.id,
        canonical: record.canonical.id,
        key: record.key,
        location: record.orphan.location,
      });
    }
  });

  const normalizedCanonicalInstances = canonicalInstances.map((instance) => {
    const canonicalInstance =
      resolveCanonicalObject(ctx, instance) ?? instance;
    canonicalInstance.genericParent = canonicalParent;
    debugCheckParentRegistration(instance, canonicalInstance, canonicalParent);
    return canonicalInstance;
  });

  canonicalParent.genericInstances = normalizedCanonicalInstances;
  canonicalizeTypeNode(ctx, canonicalParent);
  if (CANON_TRACE_RECONCILE) {
    console.log("[CANON_TRACE_RECONCILE] reconciledInstances", {
      parent: formatTypeId(canonicalParent),
      instances: normalizedCanonicalInstances.map((instance) => ({
        id: formatTypeId(instance),
        key: getInstanceKey(ctx, instance),
      })),
    });
  }
};

const reconcileInstanceWithParent = (
  ctx: CanonicalizeCtx,
  instance: ObjectType
): ObjectType | undefined => {
  const parent = instance.genericParent as ObjectType | undefined;
  if (!parent) return instance;
  const canonicalParent = resolveCanonicalObject(ctx, parent);
  if (!canonicalParent) return instance;

  const canonicalInstance = resolveCanonicalObject(ctx, instance);
  if (!canonicalInstance) return instance;

  canonicalInstance.genericParent = canonicalParent;
  if (canonicalInstance !== instance) {
    instance.genericParent = canonicalParent;
    instance.genericInstances = [];
  }

  reconcileObjectGenericInstances(ctx, canonicalParent, [canonicalInstance]);
  debugCheckParentRegistration(instance, canonicalInstance, canonicalParent);
  return canonicalInstance;
};

const dedupeTraitInstances = (
  ctx: CanonicalizeCtx,
  instances: (TraitType | undefined)[]
): TraitType[] => {
  if (!instances.length) return [];
  const seen = new Set<TraitType>();
  const result: TraitType[] = [];
  instances.forEach((instance) => {
    if (!instance) return;
    const canonical = canonicalTypeRef(ctx, instance) as TraitType | undefined;
    if (!canonical) return;
    if (!(canonical as TraitType).isTraitType?.()) return;
    const trait = canonical as TraitType;
    if (seen.has(trait)) return;
    seen.add(trait);
    result.push(trait);
  });
  return result;
};

const attachTraitInstanceToParent = (
  ctx: CanonicalizeCtx,
  instance: TraitType
): void => {
  const parent = instance.genericParent;
  if (!parent) return;

  const canonicalParent = canonicalTypeRef(ctx, parent) as
    | TraitType
    | undefined;
  if (!canonicalParent) return;
  if (!(canonicalParent as TraitType).isTraitType?.()) return;
  const traitParent = canonicalParent as TraitType;

  instance.genericParent = traitParent;
  const canonicalInstance = canonicalTypeRef(ctx, instance) as
    | TraitType
    | undefined;
  if (!canonicalInstance) return;
  if (!(canonicalInstance as TraitType).isTraitType?.()) return;
  const traitInstance = canonicalInstance as TraitType;

  const merged = dedupeTraitInstances(ctx, [
    ...(traitParent.genericInstances ?? []),
    traitInstance,
  ]);
  if (merged.length) {
    traitParent.genericInstances = merged;
  }

  canonicalizeTypeNode(ctx, traitParent);
};

type CanonicalizeResolvedTypesOpts = {
  table?: CanonicalTypeTable;
};

export const canonicalizeResolvedTypes = (
  module: VoydModule,
  opts?: CanonicalizeResolvedTypesOpts
): VoydModule => {
  const table = opts?.table ?? new CanonicalTypeTable();
  const ctx: CanonicalizeCtx = {
    table,
    visitedExpr: new Set(),
    visitedTypes: new Set(),
    requiresRevisit: false,
  };

  const runPass = () => {
    ctx.visitedExpr.clear();
    ctx.visitedTypes.clear();
    ctx.requiresRevisit = false;
    canonicalizeExpr(ctx, module);
  };

  const aggregatedEvents: CanonicalTypeDedupeEvent[] = [];
  const recordIterationEvents = (): CanonicalTypeDedupeEvent[] => {
    const events = table.getDedupeEvents();
    if (events.length) {
      aggregatedEvents.push(...events);
    }
    return events;
  };

  table.clearDedupeEvents();
  runPass();

  let dedupeEvents = recordIterationEvents();
  let iterations = 0;
  const MAX_CANON_ITERATIONS = 10;
  while (
    (dedupeEvents.length > 0 || ctx.requiresRevisit) &&
    iterations < MAX_CANON_ITERATIONS
  ) {
    iterations += 1;
    table.clearDedupeEvents();
    runPass();
    dedupeEvents = recordIterationEvents();
  }

  table.setDedupeEvents(aggregatedEvents);

  return module;
};

const canonicalTypeRef = (
  ctx: CanonicalizeCtx,
  type?: Type
): Type | undefined => {
  const canonical = ctx.table.canonicalize(type);
  if (canonical) {
    let canonicalRef = ctx.table.getCanonical(canonical);
    if (!canonicalRef) canonicalRef = canonical;
    let resolvedRef: Type | undefined = canonicalRef;
    let losingRef: Type | undefined;
    if ((resolvedRef as ObjectType).isObjectType?.()) {
      const obj = resolvedRef as ObjectType;
      const canonicalInstance = findCanonicalParentInstance(ctx, obj);
      if (canonicalInstance && canonicalInstance !== obj) {
        losingRef = obj;
        resolvedRef = canonicalInstance;
      }
    }
    if (
      type &&
      resolvedRef &&
      type !== resolvedRef &&
      (type as ObjectType).isObjectType?.() &&
      (resolvedRef as ObjectType).isObjectType?.()
    ) {
      adoptObjectMetadata(resolvedRef as ObjectType, type as ObjectType);
    }
    if (type && resolvedRef && type !== resolvedRef) {
      clearTypeCaches(type, resolvedRef);
    }
    if (
      losingRef &&
      resolvedRef &&
      (losingRef as ObjectType).isObjectType?.() &&
      (resolvedRef as ObjectType).isObjectType?.()
    ) {
      adoptObjectMetadata(
        resolvedRef as ObjectType,
        losingRef as ObjectType
      );
    }
    if (losingRef && resolvedRef && losingRef !== resolvedRef) {
      clearTypeCaches(losingRef, resolvedRef);
    }
    if (CANON_DEBUG && type && resolvedRef) {
      assertCanonicalTypeRef(ctx.table, type, resolvedRef, "canonicalTypeRef");
    }
    if (CANON_DEBUG && resolvedRef && (resolvedRef as ObjectType).isObjectType?.()) {
      const obj = resolvedRef as ObjectType;
      const parent = obj.genericParent as ObjectType | undefined;
      if (parent) {
        const canonicalParent = ctx.table.getCanonical(parent) as ObjectType | undefined;
        const parentRef = canonicalParent ?? parent;
        const registeredChildren = parentRef.genericInstances ?? [];
        const isRegistered = registeredChildren.includes(obj);
        const parentMismatch = obj.genericParent && obj.genericParent !== parentRef;
        if (!isRegistered || parentMismatch) {
          const payload = {
            canonicalInstance: formatTypeId(obj),
            instanceParent: formatTypeId(obj.genericParent as ObjectType | undefined),
            canonicalParent: formatTypeId(parentRef),
            registeredChildren: registeredChildren.map((child) =>
              formatTypeId(child as ObjectType | undefined)
            ),
          };
          console.warn(`[CANON_DEBUG] canonical lookup missing registered child`, payload);
        }
      }
    }
    if (resolvedRef) {
      canonicalizeTypeNode(ctx, resolvedRef);
    }
    return resolvedRef;
  }
  return canonical;
};

const canonicalizeExpr = (ctx: CanonicalizeCtx, expr?: Expr): void => {
  if (!expr || ctx.visitedExpr.has(expr)) return;
  ctx.visitedExpr.add(expr);

  if (expr.isModule()) {
    expr.each((child) => canonicalizeExpr(ctx, child));
    return;
  }

  if (expr.isFn()) {
    canonicalizeFn(ctx, expr);
    return;
  }

  if (expr.isClosure()) {
    canonicalizeClosure(ctx, expr);
    return;
  }

  if (expr.isMacro()) {
    canonicalizeMacro(ctx, expr);
    return;
  }

  if (expr.isMacroLambda()) {
    canonicalizeMacroLambda(ctx, expr);
    return;
  }

  if (expr.isMacroVariable()) {
    canonicalizeMacroVariable(ctx, expr);
    return;
  }

  if (expr.isVariable()) {
    canonicalizeVariable(ctx, expr);
    return;
  }

  if (expr.isParameter()) {
    canonicalizeParameter(ctx, expr);
    return;
  }

  if (expr.isBlock()) {
    if (expr.type) expr.type = canonicalTypeRef(ctx, expr.type);
    expr.body.forEach((child) => canonicalizeExpr(ctx, child));
    return;
  }

  if (expr.isCall()) {
    const type = canonicalTypeRef(ctx, expr.type);
    expr.type = type;
    const expected = expr.getAttribute?.("expectedType") as Type | undefined;
    if (expected) {
      const canonicalExpected = canonicalTypeRef(ctx, expected);
      if (canonicalExpected) {
        expr.setAttribute("expectedType", canonicalExpected);
      }
    }
    canonicalizeExpr(ctx, expr.fnName);
    canonicalizeList(ctx, expr.args);
    canonicalizeList(ctx, expr.typeArgs ?? undefined);
    const fn = expr.fn;
    if (fn) {
      if (fn.isFn?.()) canonicalizeExpr(ctx, fn);
      if ((fn as ObjectType).isObjectType?.()) {
        expr.fn = canonicalTypeRef(ctx, fn as ObjectType) as ObjectType;
      }
    }
    return;
  }

  if (expr.isObjectLiteral()) {
    canonicalizeObjectLiteral(ctx, expr);
    return;
  }

  if (expr.isArrayLiteral()) {
    const inferred = expr.getAttribute?.("inferredElemType") as Type | undefined;
    if (inferred) {
      const canonicalInferred = canonicalTypeRef(ctx, inferred);
      if (canonicalInferred) {
        expr.setAttribute("inferredElemType", canonicalInferred);
      }
    }
    expr.elements.forEach((element) => canonicalizeExpr(ctx, element));
    return;
  }

  if (expr.isMatch()) {
    canonicalizeMatch(ctx, expr);
    return;
  }

  if (expr.isImpl()) {
    canonicalizeImplementation(ctx, expr);
    return;
  }

  if (expr.isDeclaration()) {
    expr.fns.forEach((fn) => canonicalizeExpr(ctx, fn));
    return;
  }

  if (expr.isGlobal()) {
    const canonical = canonicalTypeRef(ctx, expr.type);
    if (canonical) (expr as any).type = canonical;
    canonicalizeExpr(ctx, expr.initializer);
    return;
  }

  if (expr.isTrait()) {
    canonicalizeTypeNode(ctx, expr);
    return;
  }

  if (expr.isType()) {
    canonicalizeTypeNode(ctx, expr);
    return;
  }

  if (expr.isIdentifier()) {
    if (expr.type) expr.type = canonicalTypeRef(ctx, expr.type);
    return;
  }

  if (expr.isList()) {
    canonicalizeList(ctx, expr);
    return;
  }
};

const canonicalizeList = (ctx: CanonicalizeCtx, list?: List): void => {
  if (!list) return;
  list.each((item) => canonicalizeExpr(ctx, item));
};

const canonicalizeObjectLiteral = (
  ctx: CanonicalizeCtx,
  literal: ObjectLiteral
): void => {
  if (literal.type)
    literal.type = canonicalTypeRef(ctx, literal.type) as ObjectType;
  literal.fields.forEach((field) => canonicalizeObjectLiteralField(ctx, field));
};

const canonicalizeObjectLiteralField = (
  ctx: CanonicalizeCtx,
  field: ObjectLiteralField
): void => {
  if (field.type) field.type = canonicalTypeRef(ctx, field.type);
  canonicalizeExpr(ctx, field.initializer);
};

const canonicalizeMatch = (ctx: CanonicalizeCtx, match: Match): void => {
  if (match.type) match.type = canonicalTypeRef(ctx, match.type);
  if (match.baseType) match.baseType = canonicalTypeRef(ctx, match.baseType);
  canonicalizeExpr(ctx, match.operand);
  if (match.bindVariable) canonicalizeVariable(ctx, match.bindVariable);
  canonicalizeExpr(ctx, match.bindIdentifier);
  match.cases.forEach((caseItem) => canonicalizeMatchCase(ctx, caseItem));
  if (match.defaultCase) canonicalizeMatchCase(ctx, match.defaultCase);
};

const canonicalizeMatchCase = (
  ctx: CanonicalizeCtx,
  caseItem: MatchCase
): void => {
  if (caseItem.matchType)
    caseItem.matchType = canonicalTypeRef(ctx, caseItem.matchType) as any;
  if (caseItem.matchTypeExpr) canonicalizeExpr(ctx, caseItem.matchTypeExpr);
  canonicalizeExpr(ctx, caseItem.expr);
};

const canonicalizeImplementation = (
  ctx: CanonicalizeCtx,
  impl: Implementation
): void => {
  if (impl.targetType) impl.targetType = canonicalTypeRef(ctx, impl.targetType);
  if (impl.trait) impl.trait = canonicalTypeRef(ctx, impl.trait) as TraitType;
  canonicalizeExpr(ctx, impl.targetTypeExpr.value);
  canonicalizeExpr(ctx, impl.body.value);
  canonicalizeExpr(ctx, impl.traitExpr.value);
  impl.typeParams.toArray().forEach((param) => canonicalizeExpr(ctx, param));
  impl.exports.forEach((fn) => canonicalizeExpr(ctx, fn));
  impl.methods.forEach((fn) => canonicalizeExpr(ctx, fn));
};

const canonicalizeFn = (ctx: CanonicalizeCtx, fn: Fn): void => {
  if (fn.returnType) fn.returnType = canonicalTypeRef(ctx, fn.returnType);
  if (fn.inferredReturnType)
    fn.inferredReturnType = canonicalTypeRef(ctx, fn.inferredReturnType);
  if (fn.annotatedReturnType)
    fn.annotatedReturnType = canonicalTypeRef(ctx, fn.annotatedReturnType);

  if (fn.appliedTypeArgs?.length) {
    fn.appliedTypeArgs = fn.appliedTypeArgs.map(
      (arg) => canonicalTypeRef(ctx, arg)!
    );
  }

  fn.parameters.forEach((param) => canonicalizeParameter(ctx, param));
  fn.variables.forEach((variable) => canonicalizeVariable(ctx, variable));
  fn.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));

  const instances = fn.genericInstances;
  if (instances) {
    instances.forEach((inst) => {
      canonicalizeExpr(ctx, inst);
      const returnType = inst.returnType;
      if (returnType) {
        const canonicalReturn = canonicalTypeRef(ctx, returnType);
        if (canonicalReturn) {
          inst.returnType = canonicalReturn;
        }
      }
      if (inst.inferredReturnType) {
        inst.inferredReturnType = canonicalTypeRef(
          ctx,
          inst.inferredReturnType
        );
      }
      if (inst.annotatedReturnType) {
        inst.annotatedReturnType = canonicalTypeRef(
          ctx,
          inst.annotatedReturnType
        );
      }
    });
  }

  if (fn.body) canonicalizeExpr(ctx, fn.body);
  if (fn.returnTypeExpr) canonicalizeExpr(ctx, fn.returnTypeExpr);
};

const canonicalizeClosure = (ctx: CanonicalizeCtx, closure: Closure): void => {
  if (closure.returnType)
    closure.returnType = canonicalTypeRef(ctx, closure.returnType);
  if (closure.inferredReturnType)
    closure.inferredReturnType = canonicalTypeRef(
      ctx,
      closure.inferredReturnType
    );
  if (closure.annotatedReturnType)
    closure.annotatedReturnType = canonicalTypeRef(
      ctx,
      closure.annotatedReturnType
    );

  const parameterFnType = closure.getAttribute?.(
    "parameterFnType"
  ) as Type | undefined;
  if (parameterFnType) {
    const canonicalFnType = canonicalTypeRef(ctx, parameterFnType);
    if (canonicalFnType) {
      closure.setAttribute("parameterFnType", canonicalFnType);
    }
  }

  closure.parameters.forEach((param) => canonicalizeParameter(ctx, param));
  closure.variables.forEach((variable) => canonicalizeVariable(ctx, variable));
  closure.captures.forEach((capture) => canonicalizeExpr(ctx, capture));

  if (closure.returnTypeExpr) canonicalizeExpr(ctx, closure.returnTypeExpr);
  canonicalizeExpr(ctx, closure.body);
};

const canonicalizeMacro = (ctx: CanonicalizeCtx, macro: Macro): void => {
  macro.parameters.forEach((param) => canonicalizeExpr(ctx, param));
  canonicalizeExpr(ctx, macro.body);
};

const canonicalizeMacroLambda = (
  ctx: CanonicalizeCtx,
  lambda: MacroLambda
): void => {
  lambda.parameters.forEach((param) => canonicalizeExpr(ctx, param));
  canonicalizeList(ctx, lambda.body);
};

const canonicalizeMacroVariable = (
  ctx: CanonicalizeCtx,
  variable: MacroVariable
): void => {
  if (variable.value) canonicalizeExpr(ctx, variable.value);
};

const canonicalizeParameter = (
  ctx: CanonicalizeCtx,
  parameter: Parameter
): void => {
  if (parameter.type) parameter.type = canonicalTypeRef(ctx, parameter.type);
  if (parameter.originalType)
    parameter.originalType = canonicalTypeRef(ctx, parameter.originalType);
  if (parameter.typeExpr) canonicalizeExpr(ctx, parameter.typeExpr);
};

const canonicalizeVariable = (
  ctx: CanonicalizeCtx,
  variable: Variable
): void => {
  if (variable.type) variable.type = canonicalTypeRef(ctx, variable.type);
  if (variable.originalType)
    variable.originalType = canonicalTypeRef(ctx, variable.originalType);
  if (variable.annotatedType)
    variable.annotatedType = canonicalTypeRef(ctx, variable.annotatedType);
  if (variable.inferredType)
    variable.inferredType = canonicalTypeRef(ctx, variable.inferredType);
  if (variable.typeExpr) canonicalizeExpr(ctx, variable.typeExpr);
  canonicalizeExpr(ctx, variable.initializer);
};

const canonicalizeTypeNode = (
  ctx: CanonicalizeCtx,
  type: Type
): Type | undefined => {
  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    if (ctx.visitedTypes.has(alias)) return alias;
    ctx.visitedTypes.add(alias);
    if (alias.typeExpr) canonicalizeExpr(ctx, alias.typeExpr);
    if (alias.type) alias.type = canonicalTypeRef(ctx, alias.type);
    return alias.type ?? alias;
  }

  const canonical = ctx.table.canonicalize(type);
  if (!canonical) return undefined;
  if (ctx.visitedTypes.has(canonical)) return canonical;
  ctx.visitedTypes.add(canonical);

  if ((canonical as UnionType).isUnionType?.()) {
    const union = canonical as UnionType;
    union.childTypeExprs
      .toArray()
      .forEach((expr) => canonicalizeExpr(ctx, expr));
    const reconciledChildren = union.types
      .map((child) => {
        let resolved = child;
        if (
          (child as ObjectType).isObjectType?.() &&
          isOptionalConstructor(child as ObjectType)
        ) {
          const reconciled = reconcileInstanceWithParent(
            ctx,
            child as ObjectType
          );
          if (reconciled) {
            if (CANON_DEBUG && reconciled !== child) {
              console.warn("[CANON_DEBUG] union replaced optional child", {
                original: formatTypeId(child as ObjectType),
                canonical: formatTypeId(reconciled),
                key: getInstanceKey(ctx, reconciled),
              });
            }
            resolved = reconciled;
          }
          const canonicalFromParent = findCanonicalParentInstance(
            ctx,
            resolved as ObjectType
          );
          if (
            canonicalFromParent &&
            canonicalFromParent !== (resolved as ObjectType)
          ) {
            ctx.table.registerAlias(resolved as ObjectType, canonicalFromParent);
            adoptObjectMetadata(
              canonicalFromParent,
              resolved as ObjectType
            );
            clearTypeCaches(resolved as ObjectType, canonicalFromParent);
            resolved = canonicalFromParent;
          }
        }
        const canonical = canonicalTypeRef(ctx, resolved);
        if (!canonical) return resolved as Type;
        const normalized =
          (canonicalizeTypeNode(ctx, canonical) ?? canonical) as Type;
        return normalized;
      })
      .filter(isVoydRefType);
    const seenInstanceKeys = new Map<string, ObjectType>();
    const dedupedChildren: VoydRefType[] = [];
    reconciledChildren.forEach((child) => {
      if ((child as ObjectType).isObjectType?.()) {
        const objChild = child as ObjectType;
        const canonicalChild = resolveCanonicalObject(ctx, objChild) ?? objChild;
        const parentId = formatTypeId(
          canonicalChild.genericParent as ObjectType | undefined
        );
        const key = `${parentId}:${getInstanceKey(ctx, canonicalChild)}`;
        const existing = seenInstanceKeys.get(key);
        if (existing) {
          if (existing !== canonicalChild) {
            adoptObjectMetadata(existing, canonicalChild);
            clearTypeCaches(canonicalChild, existing);
          }
          return;
        }
        seenInstanceKeys.set(key, canonicalChild);
        dedupedChildren.push(canonicalChild as VoydRefType);
        return;
      }
      dedupedChildren.push(child);
    });
    union.types = dedupedChildren;
    if (unionHasOptionalConstructors(union)) {
      const normalized = union.types
        .map((child) =>
          (child as ObjectType).isObjectType?.() &&
          isOptionalConstructor(child as ObjectType)
            ? canonicalTypeRef(ctx, child)
            : child
        )
        .filter(isVoydRefType);
      union.types = dedupeByRef(normalized);
    }
    return union;
  }

  if ((canonical as IntersectionType).isIntersectionType?.()) {
    const inter = canonical as IntersectionType;
    if (inter.nominalType)
      inter.nominalType = canonicalTypeRef(
        ctx,
        inter.nominalType
      ) as ObjectType;
    if (inter.structuralType)
      inter.structuralType = canonicalTypeRef(
        ctx,
        inter.structuralType
      ) as ObjectType;
    const nominalExpr = inter.nominalTypeExpr?.value;
    if (nominalExpr) canonicalizeExpr(ctx, nominalExpr);
    const structuralExpr = inter.structuralTypeExpr?.value;
    if (structuralExpr) canonicalizeExpr(ctx, structuralExpr);
    return inter;
  }

  if ((canonical as TupleType).isTupleType?.()) {
    const tuple = canonical as TupleType;
    tuple.value = tuple.value.map((entry) => canonicalTypeRef(ctx, entry)!);
    tuple.value.forEach((entry) => canonicalizeTypeNode(ctx, entry));
    return tuple;
  }

  if ((canonical as FixedArrayType).isFixedArrayType?.()) {
    const arr = canonical as FixedArrayType;
    if (arr.elemType) arr.elemType = canonicalTypeRef(ctx, arr.elemType);
    if (arr.elemTypeExpr) canonicalizeExpr(ctx, arr.elemTypeExpr);
    return arr;
  }

  if ((canonical as FnType).isFnType?.()) {
    const fn = canonical as FnType;
    if (fn.returnType) fn.returnType = canonicalTypeRef(ctx, fn.returnType);
    fn.parameters.forEach((param) => canonicalizeParameter(ctx, param));
    if (fn.returnTypeExpr) canonicalizeExpr(ctx, fn.returnTypeExpr);
    return fn;
  }

  if ((canonical as ObjectType).isObjectType?.()) {
    const obj = canonical as ObjectType;
    if (obj.parentObjType)
      obj.parentObjType = canonicalTypeRef(
        ctx,
        obj.parentObjType
      ) as ObjectType;
    if (obj.parentObjExpr) canonicalizeExpr(ctx, obj.parentObjExpr);
    if (obj.appliedTypeArgs?.length) {
      obj.appliedTypeArgs = obj.appliedTypeArgs
        .map((arg) => canonicalTypeRef(ctx, arg))
        .filter((arg): arg is Type => !!arg);
    }
    obj.fields.forEach((field) => {
      if (field.type) field.type = canonicalTypeRef(ctx, field.type);
      if (field.typeExpr) canonicalizeExpr(ctx, field.typeExpr);
    });
    const dedupedImplementations =
      dedupeImplementations(obj.implementations) ??
      obj.implementations ??
      [];
    obj.implementations = dedupedImplementations;
    obj.implementations.forEach((impl) => canonicalizeExpr(ctx, impl));
    if (obj.genericParent) {
      const canonicalInstance = reconcileInstanceWithParent(ctx, obj);
      if (canonicalInstance && canonicalInstance !== obj) {
        return canonicalizeTypeNode(ctx, canonicalInstance) as ObjectType;
      }
    }
    if (obj.genericInstances) {
      if (obj.genericInstances.length) {
        reconcileObjectGenericInstances(ctx, obj);
      } else {
        obj.genericInstances = [];
      }
    }
    obj.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));
    return obj;
  }

  if ((canonical as TraitType).isTraitType?.()) {
    const trait = canonical as TraitType;
    if (trait.appliedTypeArgs?.length) {
      trait.appliedTypeArgs = trait.appliedTypeArgs
        .map((arg) => canonicalTypeRef(ctx, arg))
        .filter((arg): arg is Type => !!arg);
    }
    trait.methods.toArray().forEach((method) => canonicalizeExpr(ctx, method));
    const dedupedTraitImplementations =
      dedupeImplementations(trait.implementations) ??
      trait.implementations ??
      [];
    trait.implementations = dedupedTraitImplementations;
    trait.implementations.forEach((impl) => canonicalizeExpr(ctx, impl));
    if (trait.genericInstances?.length) {
      trait.genericInstances = dedupeTraitInstances(
        ctx,
        trait.genericInstances
      );
    }
    if (trait.genericParent) {
      attachTraitInstanceToParent(ctx, trait);
    }
    trait.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));
    return trait;
  }

  return canonical;
};

export default canonicalizeResolvedTypes;
