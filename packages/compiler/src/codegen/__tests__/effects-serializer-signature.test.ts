import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileEffectFixture, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-serializer-signature.voyd"
);
const importedFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-serializer-imported-signature",
  "pkg.voyd"
);

describe("effect signature hashing", () => {
  it("includes serializer metadata in signature hashes", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const table = parseEffectTable(module);
    const direct = table.ops.find((op) => op.label.endsWith("Serializer.direct"));
    const alias = table.ops.find((op) => op.label.endsWith("Serializer.alias"));
    if (!direct || !alias) {
      throw new Error("missing Serializer ops in effect table");
    }
    expect(direct.signatureHash).not.toBe(alias.signatureHash);
  });

  it("preserves imported declared alias serializers for effect signatures", async () => {
    const { module } = await compileEffectFixture({ entryPath: importedFixturePath });
    const table = parseEffectTable(module);
    const op = table.ops.find((entry) =>
      entry.label.endsWith("ImportedSerializer.roundtrip")
    );
    expect(op).toBeDefined();
  });
});
