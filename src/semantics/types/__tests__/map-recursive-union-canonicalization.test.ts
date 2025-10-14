import { describe, expect, test } from "vitest";
import { parseModule } from "../../../parser/index.js";
import { processSemantics } from "../../index.js";
import { mapRecursiveUnionVoyd } from "../../../__tests__/fixtures/map-recursive-union.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Identifier } from "../../../syntax-objects/index.js";
import {
  ObjectType,
  TypeAlias,
  UnionType,
  i32,
  type Type,
} from "../../../syntax-objects/types.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { codegen } from "../../../codegen.js";
import {
  collectOptionalConstructors,
  isOptionalNoneConstructor,
  isOptionalSomeConstructor,
} from "../debug/collect-optional-constructors.js";
import {
  createTypeContext,
  internTypeImmediately,
  withTypeContext,
} from "../type-context.js";

const collectModules = (root: VoydModule): VoydModule[] => {
  const visited = new Set<VoydModule>();
  const queue: VoydModule[] = [root];
  const modules: VoydModule[] = [];
  while (queue.length) {
    const module = queue.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    modules.push(module);
    module.each((expr) => {
      if (expr.isModule?.()) {
        queue.push(expr as unknown as VoydModule);
      }
    });
  }
  return modules;
};

const collectGenericOwners = (
  root: VoydModule
): { objectTypes: ObjectType[]; traitTypes: TraitType[] } => {
  const modules = collectModules(root);
  const objects = new Set<ObjectType>();
  const traits = new Set<TraitType>();
  modules.forEach((module) => {
    module.lexicon.getAllEntities().forEach((entity) => {
      const candidate = entity as Type;
      if (candidate?.isObjectType?.()) {
        const obj = candidate as ObjectType;
        objects.add(obj);
        obj.genericInstances?.forEach((instance) => {
          if (instance?.isObjectType?.()) objects.add(instance as ObjectType);
        });
      }
      if ((candidate as TraitType)?.isTraitType?.()) {
        const trait = candidate as TraitType;
        traits.add(trait);
        trait.genericInstances?.forEach((instance) => {
          if ((instance as TraitType)?.isTraitType?.()) {
            traits.add(instance as TraitType);
          }
        });
      }
    });
  });
  return { objectTypes: [...objects], traitTypes: [...traits] };
};

describe("map-recursive-union optional constructor canonicalization", () => {
  test("ObjectType registerGenericInstance keeps canonical instances", () => {
    const base = new ObjectType({
      name: Identifier.from("Some"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });

    const context = createTypeContext();
    withTypeContext(context, () => {
      const buildAlias = () => {
        const alias = new TypeAlias({
          name: Identifier.from("T"),
          typeExpr: Identifier.from("T"),
        });
        alias.type = i32;
        return alias;
      };

      const freshInstance = () => {
        const inst = base.clone();
        inst.typeParameters = undefined;
        inst.genericParent = base;
        inst.appliedTypeArgs = [buildAlias()];
        return inst;
      };

      const canonicalFirst = internTypeImmediately(freshInstance()) as ObjectType;
      const registeredFirst = base.registerGenericInstance(canonicalFirst);
      expect(registeredFirst).toBe(canonicalFirst);

      const canonicalSecond = internTypeImmediately(freshInstance()) as ObjectType;
      const registeredSecond = base.registerGenericInstance(canonicalSecond);

      expect(registeredSecond).toBe(canonicalFirst);
      expect(base.genericInstances).toHaveLength(1);
      expect(base.genericInstances?.[0]).toBe(canonicalFirst);
      expect(canonicalFirst.genericParent).toBe(base);
    });
  });

  test.skip(
    "reuses canonical Some/None instances across generics (Phase 7)",
    async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { some, none, unions, divergences } = collectOptionalConstructors(
      srcModule ?? canonicalRoot
    );

    expect(divergences).toHaveLength(0);

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

  test.skip(
    "Some generic parent dedupes RecType specialization (Phase 7)",
    async () => {
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
      divergences,
    } = collectOptionalConstructors(srcModule ?? canonicalRoot);

    expect(divergences).toHaveLength(0);

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

  test("generic parents expose canonical metadata", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { objectTypes, traitTypes } = collectGenericOwners(
      srcModule ?? canonicalRoot
    );

    objectTypes.forEach((obj) => {
      const instances = obj.genericInstances ?? [];
      const unique = new Set(instances);
      expect(unique.size).toBe(instances.length);
      instances.forEach((instance) => {
        expect(instance.genericParent).toBe(obj);
      });
    });

    traitTypes.forEach((trait) => {
      const instances = trait.genericInstances ?? [];
      const unique = new Set(instances);
      expect(unique.size).toBe(instances.length);
      instances.forEach((instance) => {
        expect(instance.genericParent).toBe(trait);
      });
    });
  });

  test.skip(
    "optional constructors remain attached to the canonical Some parent (Phase 7)",
    async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { some, none, parentByInstance, divergences } = collectOptionalConstructors(
      srcModule ?? canonicalRoot
    );

    expect(divergences).toHaveLength(0);

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

    parentInstances.forEach((instance) => {
      expect(instance.genericParent).toBe(canonicalParent);
      expect(parentByInstance.get(instance)).toBe(canonicalParent);
    });

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

  test.skip(
    "optional constructors keep Binaryen caches after codegen (Phase 7)",
    async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const module = codegen(canonicalRoot);

    try {
      const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
        | VoydModule
        | undefined;
      expect(srcModule).toBeDefined();

      const { some, none, unions, divergences } = collectOptionalConstructors(
        srcModule ?? canonicalRoot
      );

      expect(divergences).toHaveLength(0);

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
