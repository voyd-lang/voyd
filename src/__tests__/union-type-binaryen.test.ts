import { describe, test, expect } from "vitest";
import binaryen from "binaryen";
import { buildUnionType } from "../codegen.js";
import { UnionType, PrimitiveType, voydBaseObject } from "../syntax-objects/types.js";
import { initExtensionHelpers } from "../codegen/rtt/extension.js";
import { initFieldLookupHelpers, initMethodLookupHelpers } from "../codegen/index.js";

// Ensure buildUnionType returns anyref when union members are not all object subtypes

describe("buildUnionType", () => {
  test("falls back to anyref for non-object members", () => {
    const mod = new binaryen.Module();
    mod.setFeatures(binaryen.Features.All);
    mod.setMemory(0, 1, "main_memory", []);

    const extensionHelpers = initExtensionHelpers(mod);
    const fieldLookupHelpers = initFieldLookupHelpers(mod);
    const methodLookupHelpers = initMethodLookupHelpers(mod);

    const union = new UnionType({ name: "U" });
    union.types = [PrimitiveType.from("i32"), voydBaseObject];

    const opts = {
      mod,
      expr: union as any,
      extensionHelpers,
      fieldLookupHelpers,
      methodLookupHelpers,
    };

    const typeRef = buildUnionType(opts, union);
    expect(typeRef).toBe(binaryen.anyref);
  });
});
