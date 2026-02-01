import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";
import { formatSignatureHash, parseEffectTable } from "@voyd/js-host/protocol/table.js";

const assertNoCompileErrors = (
  diagnostics: { severity: string; message: string }[],
): void => {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return;
  throw new Error(errors.map((d) => d.message).join("\n"));
};

describe("smoke: effects host boundary", () => {
  it("runs effectful exports with JS handlers (Async.await)", async () => {
    const sdk = createSdk();
    const entryPath = path.join(
      process.cwd(),
      "fixtures",
      "effects-host-boundary.voyd",
    );
    const result = await sdk.compile({ entryPath });
    assertNoCompileErrors(result.diagnostics);

    const effectTable = parseEffectTable(result.wasm);
    const awaitOp = effectTable.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const handlerKeyFor = (op: { effectId: string; opId: number; signatureHash: number }): string =>
      `${op.effectId}:${op.opId}:${formatSignatureHash(op.signatureHash)}`;

    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      [handlerKeyFor(awaitOp)]: (value: unknown): number => {
        if (typeof value !== "number") {
          throw new Error(`expected Async.await arg to be a number, got ${typeof value}`);
        }
        return value + 1;
      },
    };

    effectTable.ops
      .filter((op) => op.label.startsWith("std::test::assertions::Test."))
      .forEach((op) => {
        handlers[handlerKeyFor(op)] = () => {
          throw new Error(`unexpected test assertion effect in smoke test: ${op.label}`);
        };
      });

    const output = await result.run<number>({
      entryName: "main",
      handlers,
    });

    expect(output).toBe(1222);
  });
});
