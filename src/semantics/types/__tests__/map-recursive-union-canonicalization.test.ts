import { describe, expect, test } from "vitest";
import { parseModule } from "../../../parser/index.js";
import { processSemantics } from "../../index.js";
import { mapRecursiveUnionVoyd } from "../../../__tests__/fixtures/map-recursive-union.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { ObjectType, TypeAlias, UnionType } from "../../../syntax-objects/types.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { codegen } from "../../../codegen.js";
import {
  collectOptionalConstructors,
  isOptionalNoneConstructor,
  isOptionalSomeConstructor,
} from "../debug/collect-optional-constructors.js";

describe("map-recursive-union optional constructor canonicalization", () => {
  test("reuses canonical Some/None instances across generics", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { some, none, unions } = collectOptionalConstructors(
      srcModule ?? canonicalRoot
    );

    const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
      | TypeAlias
      | undefined;
    expect(recAlias?.type?.isUnionType?.()).toBe(true);

    const recUnion = recAlias?.type as UnionType;
    const recOptional = [...unions].find((union) =>
      union.types.some((candidate) => {
        if (!(candidate as ObjectType).isObjectType?.()) return false;
        const obj = candidate as ObjectType;
        return (
          isOptionalSomeConstructor(obj) && obj.appliedTypeArgs?.[0] === recUnion
        );
      })
    );

    expect(recOptional).toBeDefined();

    const recSomeVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalSomeConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;
    const recNoneVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalNoneConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;

    expect(recSomeVariant?.appliedTypeArgs?.[0]).toBe(recUnion);
    expect(recNoneVariant).toBeDefined();

    const someBase = recSomeVariant?.genericParent;
    const recSomeInstances = (someBase?.genericInstances ?? []).filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );
    expect(recSomeInstances).toHaveLength(1);
    expect(recSomeInstances[0]).toBe(recSomeVariant);

    const recNoneInstances = [...none].filter(
      (candidate) => candidate === recNoneVariant
    );
    expect(recNoneInstances).toHaveLength(1);

    const debugTable = new CanonicalTypeTable({ recordEvents: true });
    canonicalizeResolvedTypes(srcModule ?? canonicalRoot, { table: debugTable });
    const optionalDedupeEvents = debugTable
      .getDedupeEvents()
      .filter((event) => {
        const canonical = event.canonical as ObjectType;
        if (!canonical?.isObjectType?.()) return false;
        const reused = event.reused as ObjectType;
        if (reused?.lexicon !== canonical.lexicon) return false;
        return (
          isOptionalSomeConstructor(canonical) ||
          isOptionalNoneConstructor(canonical)
        );
      });
    expect(optionalDedupeEvents).toHaveLength(0);
  });

  test("Some generic parent dedupes RecType specialization", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const {
      some,
      unions,
      edges,
      parentByInstance,
    } = collectOptionalConstructors(srcModule ?? canonicalRoot);

    const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
      | TypeAlias
      | undefined;
    expect(recAlias?.type?.isUnionType?.()).toBe(true);

    const recUnion = recAlias?.type as UnionType;
    const recOptional = [...unions].find((union) =>
      union.types.some((candidate) => {
        if (!(candidate as ObjectType).isObjectType?.()) return false;
        const obj = candidate as ObjectType;
        return (
          isOptionalSomeConstructor(obj) && obj.appliedTypeArgs?.[0] === recUnion
        );
      })
    );

    expect(recOptional).toBeDefined();

    const recSomeVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalSomeConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;
    expect(recSomeVariant).toBeDefined();
    const recSome = recSomeVariant!;

    const recNoneVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalNoneConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;
    expect(recNoneVariant).toBeDefined();

    const parent = recSome.genericParent;
    expect(parent).toBeDefined();
    const parentObj = parent!;
    expect(parentByInstance.get(recSome)).toBe(parentObj);

    const parentInstances = parentObj.genericInstances ?? [];
    const recInstances = parentInstances.filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );
    expect(recInstances).toHaveLength(1);
    expect(recInstances[0]).toBe(recSome);

    const parentEdges = edges.get(parentObj);
    expect(parentEdges).toBeDefined();
    const recEdgeInstances = [...(parentEdges ?? [])].filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );
    expect(recEdgeInstances).not.toHaveLength(0);
    expect(recEdgeInstances).toContain(recSome);
    recEdgeInstances.forEach((candidate) => {
      expect(candidate.genericParent).toBe(parentObj);
    });

    const recSomeInstances = [...some].filter(
      (candidate) =>
        candidate.appliedTypeArgs?.[0] === recUnion &&
        candidate.genericParent === parentObj
    );
    expect(recSomeInstances).not.toHaveLength(0);
    expect(recSomeInstances).toContain(recSome);
    recSomeInstances.forEach((candidate) => {
      expect(candidate.genericParent).toBe(parentObj);
    });
  });

  test("optional constructors remain attached to the canonical Some parent", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { some, none, parentByInstance } = collectOptionalConstructors(
      srcModule ?? canonicalRoot
    );

    const clonedOptionals = [...some, ...none].filter(
      (candidate) => candidate.id.split("#").length > 2
    );

    clonedOptionals.forEach((candidate) => {
      expect(candidate.genericParent).toBeDefined();
      const parent = candidate.genericParent!;
      expect(parentByInstance.get(candidate)).toBe(parent);
    });

    const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
      | TypeAlias
      | undefined;
    expect(recAlias?.type?.isUnionType?.()).toBe(true);

    const recUnion = recAlias?.type as UnionType;

    const recSomeInstances = [...some].filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );
    expect(recSomeInstances.length).toBeGreaterThan(0);

    const canonicalParent = recSomeInstances[0]?.genericParent;
    expect(canonicalParent).toBeDefined();

    const parentInstances = (canonicalParent?.genericInstances ?? []).filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );

    expect(parentInstances.length).toBeGreaterThan(0);

    recSomeInstances.forEach((instance) => {
      const matched = parentInstances.find(
        (candidate) =>
          candidate === instance ||
          candidate.appliedTypeArgs?.[0] === instance.appliedTypeArgs?.[0]
      );
      expect(matched).toBeDefined();
      expect(matched?.genericParent).toBe(canonicalParent);
    });
  });

  test("optional constructors keep Binaryen caches after codegen", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const module = codegen(canonicalRoot);

    try {
      const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
        | VoydModule
        | undefined;
      expect(srcModule).toBeDefined();

      const { some, none, unions } = collectOptionalConstructors(
        srcModule ?? canonicalRoot
      );

      const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
        | TypeAlias
        | undefined;
      expect(recAlias?.type?.isUnionType?.()).toBe(true);

      const recUnion = recAlias?.type as UnionType;
      const recOptional = [...unions].find((union) =>
        union.types.some((candidate) => {
          if (!(candidate as ObjectType).isObjectType?.()) return false;
          const obj = candidate as ObjectType;
          return (
            isOptionalSomeConstructor(obj) &&
            obj.appliedTypeArgs?.[0] === recUnion
          );
        })
      );
      expect(recOptional).toBeDefined();

      const recSomeVariant = recOptional?.types.find(
        (candidate) =>
          (candidate as ObjectType).isObjectType?.() &&
          isOptionalSomeConstructor(candidate as ObjectType)
      ) as ObjectType | undefined;
      const recNoneVariant = recOptional?.types.find(
        (candidate) =>
          (candidate as ObjectType).isObjectType?.() &&
          isOptionalNoneConstructor(candidate as ObjectType)
      ) as ObjectType | undefined;

      expect(recSomeVariant).toBeDefined();
      expect(recNoneVariant).toBeDefined();

      const recSomeInstances = [...some].filter(
        (candidate) => candidate === recSomeVariant
      );
      const recNoneInstances = [...none].filter(
        (candidate) => candidate === recNoneVariant
      );
      expect(recSomeInstances).toHaveLength(1);
      expect(recNoneInstances).toHaveLength(1);

      expect(recSomeVariant?.binaryenType).not.toBeUndefined();
      expect(recNoneVariant?.binaryenType).not.toBeUndefined();
    } finally {
      module.dispose();
    }
  });
});
