import { describe, expect, test } from "vitest";
import { Identifier } from "../../../syntax-objects/index.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import { ObjectType, TypeAlias, bool } from "../../../syntax-objects/types.js";
import { TypeInterner } from "../type-interner.js";
import { runTypeInternerOnModule } from "../type-interner-harness.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";

const createStructuralPoint = (): ObjectType => {
  const fieldExpr = Identifier.from("bool");
  const point = new ObjectType({
    name: Identifier.from("Point"),
    value: [
      {
        name: "flag",
        typeExpr: fieldExpr,
        type: bool,
      },
    ],
    isStructural: true,
  });
  point.fields[0].type = bool;
  return point;
};

describe("TypeInterner", () => {
  test("dedupes recursive unions and their generic instances", () => {
    const recA = createRecursiveUnion("RecA");
    const recB = createRecursiveUnion("RecB");

    const interner = new TypeInterner({ recordEvents: true });
    const canonicalUnionA = interner.intern(recA.union);
    const canonicalUnionB = interner.intern(recB.union);

    expect(canonicalUnionA).toBe(canonicalUnionB);
    const canonicalMapA = interner.intern(recA.mapInstance);
    const canonicalMapB = interner.intern(recB.mapInstance);

    expect(canonicalMapA).toBe(canonicalMapB);
    expect(canonicalMapA.appliedTypeArgs?.[0]).toBe(canonicalUnionA);

    const stats = interner.getStats();
    expect(stats.canonical).toBeGreaterThanOrEqual(2);
    expect(stats.reused).toBeGreaterThanOrEqual(1);
    expect(interner.getEvents().length).toBeGreaterThanOrEqual(1);
  });

  test("aliases resolve to canonical union handles", () => {
    const rec = createRecursiveUnion("RecAlias");

    const interner = new TypeInterner({ recordEvents: true });
    const canonicalFromAlias = interner.intern(rec.alias);

    expect(canonicalFromAlias).toBe(rec.union);

    const canonicalDirect = interner.intern(rec.union);
    expect(canonicalDirect).toBe(canonicalFromAlias);

    const aliasSecondPass = interner.intern(rec.alias);
    expect(aliasSecondPass).toBe(canonicalDirect);

    const additionalAlias = new TypeAlias({
      name: Identifier.from("RecAliasSecondary"),
      typeExpr: rec.union,
    });
    additionalAlias.type = rec.union;

    const canonicalFromAdditionalAlias = interner.intern(additionalAlias);
    expect(canonicalFromAdditionalAlias).toBe(canonicalDirect);
  });

  test("reuses structural object snapshots", () => {
    const structA = createStructuralPoint();
    const structB = createStructuralPoint();

    const interner = new TypeInterner({ recordEvents: true });
    const canonicalA = interner.intern(structA);
    const canonicalB = interner.intern(structB);

    expect(canonicalA).toBe(canonicalB);
    expect(canonicalA.isStructural).toBe(true);
    expect(canonicalA.fields[0].type).toBe(bool);

    const stats = interner.getStats();
    expect(stats.canonical).toBe(1);
    expect(stats.reused).toBe(1);
    expect(interner.getEvents().length).toBe(1);
  });

  test("harness interns modules produced by the resolver", () => {
    const recA = createRecursiveUnion("RecHarnessA");
    const recB = createRecursiveUnion("RecHarnessB");
    const module = new VoydModule({
      name: Identifier.from("Root"),
      value: [recA.alias, recB.alias],
    });

    const { interner, stats, events } = runTypeInternerOnModule(module, {
      recordEvents: true,
    });

    expect(stats.canonical).toBeGreaterThan(0);
    expect(stats.reused).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    const canonicalUnion = interner.intern(recA.union);
    const duplicateUnion = interner.intern(recB.union);

    expect(canonicalUnion).toBe(duplicateUnion);
  });
});
