import { describe, expect, test } from "vitest";
import { Block } from "../../../syntax-objects/block.js";
import { Fn } from "../../../syntax-objects/fn.js";
import { Identifier } from "../../../syntax-objects/index.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import {
  ObjectType,
  Type,
  UnionType,
} from "../../../syntax-objects/types.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";
import { typeKey } from "../type-key.js";
import { createRecursiveUnion } from "./helpers/rec-type.js";

const createFnWithReturn = (name: string, returnType: Type): Fn => {
  const fn = new Fn({
    name: Identifier.from(name),
    parameters: [],
    body: new Block({ body: [] }),
  });
  fn.returnType = returnType;
  return fn;
};

describe("canonicalizeResolvedTypes – validator mode", () => {
  test("reports duplicate unions without mutating return types", () => {
    const recA = createRecursiveUnion("RecA");
    const recB = createRecursiveUnion("RecB");
    const fnA = createFnWithReturn("fromA", recA.union);
    const fnB = createFnWithReturn("fromB", recB.union);

    const module = new VoydModule({
      name: Identifier.from("Root"),
      value: [recA.alias, recB.alias, fnA, fnB],
    });

    const fingerprints: string[] = [];
    canonicalizeResolvedTypes(module, {
      onDuplicate: (issue) => fingerprints.push(issue.fingerprint),
    });

    expect(fnA.returnType).toBe(recA.union);
    expect(fnB.returnType).toBe(recB.union);
    expect(fnA.returnType).not.toBe(fnB.returnType);
    expect(fingerprints).toContain(typeKey(recA.union));
    expect(fingerprints).toContain(typeKey(recA.mapInstance));
    expect(fingerprints.length).toBeGreaterThanOrEqual(2);
  });

  test("populates CanonicalTypeTable dedupe events when provided", () => {
    const recA = createRecursiveUnion("RecA");
    const recB = createRecursiveUnion("RecB");
    const fnA = createFnWithReturn("fromA", recA.union);
    const fnB = createFnWithReturn("fromB", recB.union);

    const module = new VoydModule({
      name: Identifier.from("Root"),
      value: [recA.alias, recB.alias, fnA, fnB],
    });

    const table = new CanonicalTypeTable({ recordEvents: true });
    canonicalizeResolvedTypes(module, { table });
    const events = table.getDedupeEvents();

    expect(events.length).toBeGreaterThan(0);
    const eventFingerprints = events.map((event) => event.fingerprint);
    expect(eventFingerprints).toContain(typeKey(recA.union));
  });

  test("leaves generic instance collections untouched", () => {
    const rec = createRecursiveUnion("Rec");
    const someBase = new ObjectType({
      name: Identifier.from("Some"),
      value: [
        {
          name: "value",
          typeExpr: Identifier.from("T"),
        },
      ],
      typeParameters: [Identifier.from("T")],
    });
    const noneBase = new ObjectType({
      name: Identifier.from("None"),
      value: [],
    });

    const createSomeInstance = (arg: Type): ObjectType => {
      const some = someBase.clone();
      some.genericParent = someBase;
      some.typeParameters = undefined;
      some.appliedTypeArgs = [arg];
      some.fields[0].type = arg;
      some.typesResolved = true;
      return some;
    };

    const someFromAlias = createSomeInstance(rec.alias);
    const someFromUnion = createSomeInstance(rec.union);
    someBase.genericInstances = [someFromAlias, someFromUnion];

    const optionalAlias = new UnionType({
      name: Identifier.from("OptionalAlias"),
      childTypeExprs: [],
    });
    optionalAlias.types = [someFromAlias, noneBase];

    const optionalUnion = new UnionType({
      name: Identifier.from("OptionalUnion"),
      childTypeExprs: [],
    });
    optionalUnion.types = [someFromUnion, noneBase];

    const fnAlias = createFnWithReturn("fromAlias", optionalAlias);
    const fnUnion = createFnWithReturn("fromUnion", optionalUnion);

    const module = new VoydModule({
      name: Identifier.from("Root"),
      value: [rec.alias, fnAlias, fnUnion],
    });

    canonicalizeResolvedTypes(module);

    expect(someBase.genericInstances).toEqual([someFromAlias, someFromUnion]);
    expect(fnAlias.returnType).toBe(optionalAlias);
    expect(fnUnion.returnType).toBe(optionalUnion);
  });
});
