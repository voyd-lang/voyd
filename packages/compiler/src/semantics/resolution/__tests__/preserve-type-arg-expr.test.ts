import { describe, expect, test } from "vitest";
import {
  Fn,
  Identifier,
  List,
  Parameter,
  Obj,
} from "../../../syntax-objects/index.js";
import { TypeAlias } from "../../../syntax-objects/index.js";
import { RootModule } from "../../../syntax-objects/module.js";
import { Call } from "../../../syntax-objects/call.js";
import { resolveFn } from "../resolve-fn.js";
import { TraitType } from "../../../syntax-objects/trait.js";
import { resolveTrait } from "../resolve-trait.js";

describe("Preserve type-arg expressions on specialization", () => {
  test("resolveFn stores original type arg expr on appliedTypeArgs", () => {
    const T = Identifier.from("T");
    const StringId = Identifier.from("String");

    // fn hi<T>(arg: Array<T>) -> i32
    const arrayT = new Call({
      fnName: Identifier.from("Array"),
      args: new List({}),
      typeArgs: new List({ value: [T.clone()] }),
    });
    const mod = new RootModule({});
    const fn = new Fn({
      name: Identifier.from("hi"),
      parameters: [
        new Parameter({ name: Identifier.from("arg"), typeExpr: arrayT }),
      ],
      typeParameters: [T],
      parent: mod,
    });
    // Register 'String' type in module scope so both fn and clones can resolve it
    const stringType = new Obj({
      name: Identifier.from("String"),
      fields: [],
    });
    mod.registerEntity(stringType);

    // Call with explicit type arg hi<String>(...)
    const call = new Call({
      fnName: Identifier.from("hi"),
      args: new List({}),
      // Supply the actual type node so resolution doesn't depend on identifier lookup
      typeArgs: new List({ value: [stringType] }),
    });

    resolveFn(fn, call);
    const inst = fn.genericInstances?.[0]!;
    const applied = inst.resolvedTypeArgs?.[0];
    expect(applied?.isTypeAlias?.()).toBe(true);
    expect((applied as TypeAlias)?.typeExpr?.isType?.()).toBe(true);
    expect((applied as TypeAlias)?.resolvedType?.isObj?.()).toBe(true);
    expect((applied as TypeAlias)?.resolvedType?.name?.value).toBe("String");
  });

  test("resolveTrait stores original type arg expr on appliedTypeArgs", () => {
    const T = Identifier.from("T");
    const trait = new TraitType({
      name: Identifier.from("Iterable"),
      methods: [],
      typeParameters: [T],
    });
    // Register 'String' in a root module so the cloned trait instance can resolve
    const tmod = new RootModule({});
    tmod.registerEntity(
      new Obj({ name: Identifier.from("String"), fields: [] })
    );
    trait.parent = tmod;

    const call = new Call({
      fnName: Identifier.from("Iterable"),
      args: new List({}),
      typeArgs: new List({ value: [Identifier.from("String")] }),
    });

    resolveTrait(trait, call);
    const inst = trait.genericInstances?.[0]!;
    const applied = inst.resolvedTypeArgs?.[0] as any;
    expect(applied?.isTypeAlias?.()).toBe(true);
    expect(applied?.typeExpr?.isIdentifier?.()).toBe(true);
    expect(applied?.typeExpr?.value).toBe("String");
  });
});
