import { describe, test } from "vitest";
import { parseModule } from "../parser/index.js";
import { processSemantics } from "../semantics/index.js";
import { mapRecursiveUnionVoyd } from "./fixtures/map-recursive-union.js";
import {
  withCanonicalization,
  setCanonicalizationOverride,
} from "../semantics/types/canonicalization-feature.js";
import { CanonicalTypeTable } from "../semantics/types/canonical-type-table.js";
import { canonicalizeResolvedTypes } from "../semantics/types/canonicalize-resolved-types.js";
import { VoydModule } from "../syntax-objects/module.js";
import { Identifier } from "../syntax-objects/index.js";
import {
  TypeAlias,
  UnionType,
  ObjectType,
  Type,
} from "../syntax-objects/types.js";
import { Fn } from "../syntax-objects/fn.js";
import { Expr } from "../syntax-objects/expr.js";
import { Call } from "../syntax-objects/call.js";
import { typeKey } from "../semantics/types/type-key.js";

type DedupeStats = {
  total: number;
  someCount: number;
};

type RecTypeSnapshot = {
  mapVariant?: ObjectType;
  mapVariantArg?: Type;
  mapCallType?: ObjectType;
  mapCallArg?: Type;
  mapVariantKey?: string;
  mapCallKey?: string;
};

const loadRootModule = async (
  canonicalizationEnabled: boolean
): Promise<VoydModule> => {
  const parsedModule = await parseModule(mapRecursiveUnionVoyd);
  return (await withCanonicalization(canonicalizationEnabled, () =>
    processSemantics(parsedModule)
  )) as VoydModule;
};

const analyzeDedupeStats = (root: VoydModule): DedupeStats => {
  const table = new CanonicalTypeTable({ recordEvents: true });
  canonicalizeResolvedTypes(root, { table });
  const events = table.getDedupeEvents();
  const someCount = events.reduce((count, event) => {
    const canonical = event.canonical as unknown as Record<string, unknown>;
    const name = (canonical as any)?.name?.toString?.();
    return name === "Some" ? count + 1 : count;
  }, 0);
  return {
    total: events.length,
    someCount,
  };
};

const collectCalls = (
  expr: Expr | undefined,
  result: Call[] = [],
  visited = new Set<Expr>()
): Call[] => {
  if (!expr || visited.has(expr)) return result;
  visited.add(expr);

  if (expr.isCall()) {
    const call = expr as Call;
    result.push(call);
    call.args.toArray().forEach((arg) => collectCalls(arg, result, visited));
    call.typeArgs
      ?.toArray()
      ?.forEach((arg) => collectCalls(arg, result, visited));
    if (call.fn?.isFn?.())
      collectCalls(call.fn as unknown as Expr, result, visited);
    return result;
  }

  if (expr.isBlock()) {
    expr.body.forEach((child) => collectCalls(child, result, visited));
    return result;
  }

  if (expr.isMatch()) {
    collectCalls(expr.operand, result, visited);
    expr.cases.forEach(({ expr: caseExpr, matchTypeExpr }) => {
      collectCalls(caseExpr, result, visited);
      if (matchTypeExpr) collectCalls(matchTypeExpr, result, visited);
    });
    if (expr.defaultCase) {
      collectCalls(expr.defaultCase.expr, result, visited);
      if (expr.defaultCase.matchTypeExpr)
        collectCalls(expr.defaultCase.matchTypeExpr, result, visited);
    }
    return result;
  }

  if (expr.isVariable()) {
    collectCalls(expr.initializer, result, visited);
    if (expr.typeExpr) collectCalls(expr.typeExpr, result, visited);
    return result;
  }

  if (expr.isArrayLiteral()) {
    expr.elements.forEach((element) => collectCalls(element, result, visited));
    return result;
  }

  if (expr.isObjectLiteral()) {
    expr.fields.forEach((field) =>
      collectCalls(field.initializer, result, visited)
    );
    return result;
  }

  if (expr.isFn()) {
    collectCalls(expr.body, result, visited);
    expr.parameters.forEach((param) => {
      if (param.typeExpr) collectCalls(param.typeExpr, result, visited);
    });
    expr.variables.forEach((variable) =>
      collectCalls(variable.initializer, result, visited)
    );
  }

  return result;
};

const captureRecTypeSnapshot = (root: VoydModule): RecTypeSnapshot => {
  const srcModule = root.resolveModule(Identifier.from("src")) as VoydModule;
  if (!srcModule) return {};

  const recAlias = srcModule.resolveEntity(Identifier.from("RecType")) as
    | TypeAlias
    | undefined;
  if (!recAlias?.type) return {};

  const recUnion = recAlias.type as UnionType;
  const mapVariant = recUnion.types.find(
    (type) =>
      type.isObjectType?.() &&
      ((type as ObjectType).genericParent?.name?.is("Map") ||
        (type as ObjectType).name?.is?.("Map"))
  ) as ObjectType | undefined;

  const [makeMap] = srcModule.resolveFns(Identifier.from("make_map")) as
    | Fn[]
    | undefined;

  const mapCall = makeMap
    ? collectCalls(makeMap.body as Expr).find((call) => call.fnName.is("Map"))
    : undefined;

  return {
    mapVariant,
    mapVariantArg: mapVariant?.appliedTypeArgs?.[0],
    mapCallType: (mapCall?.type as ObjectType | undefined) ?? undefined,
    mapCallArg: ((mapCall?.type as ObjectType | undefined)?.appliedTypeArgs ??
      [])[0],
    mapVariantKey: mapVariant ? typeKey(mapVariant) : undefined,
    mapCallKey: mapCall?.type ? typeKey(mapCall.type) : undefined,
  };
};

describe("map-recursive-union canonicalization integration", () => {
  test("manual canonicalization unwraps RecType alias and dedupes Map<RecType>", async (t) => {
    const root = await loadRootModule(false);
    const before = captureRecTypeSnapshot(root);
    t.expect(before.mapVariantArg?.kindOfType).toBe("type-alias");

    const table = new CanonicalTypeTable({ recordEvents: true });
    canonicalizeResolvedTypes(root, { table });

    const after = captureRecTypeSnapshot(root);
    t.expect(after.mapVariantArg?.kindOfType).toBe("union");
    t.expect(table.getDedupeEvents().length).toBeGreaterThan(0);
    t.expect(
      table
        .getDedupeEvents()
        .some(
          (event) =>
            (event.canonical as ObjectType).name?.toString?.() === "Some"
        )
    ).toBe(true);
  });

  test("pipeline canonicalization reduces duplicate type fingerprints", async (t) => {
    const rootWithout = await loadRootModule(false);
    const statsWithout = analyzeDedupeStats(rootWithout);

    const rootWith = await loadRootModule(true);
    const statsWith = analyzeDedupeStats(rootWith);
    const snapshotWith = captureRecTypeSnapshot(rootWith);

    t.expect(statsWithout.total).toBeGreaterThan(statsWith.total);
    t.expect(statsWithout.total - statsWith.total).toBeGreaterThan(100);
    t.expect(statsWith.someCount).toBeGreaterThanOrEqual(1);
  });
});

// Ensure global override is cleared if tests mutate it.
setCanonicalizationOverride(undefined);
