import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk } from "@voyd/sdk";
import {
  formatSignatureHash,
  parseEffectTable,
  type ParsedEffectOp,
  type ParsedEffectTable,
} from "@voyd/js-host";

const assertNoCompileErrors = (
  diagnostics: { severity: string; message: string }[],
): void => {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return;
  throw new Error(errors.map((d) => d.message).join("\n"));
};

const fixtureEntryPath = path.join(
  process.cwd(),
  "fixtures",
  "effects-host-boundary.voyd",
);

const handlerKeyFor = (op: {
  effectId: string;
  opId: number;
  signatureHash: number;
}): string => `${op.effectId}:${op.opId}:${formatSignatureHash(op.signatureHash)}`;

const findUniqueOpByLabelSuffix = (
  table: ParsedEffectTable,
  labelSuffix: string,
): ParsedEffectOp => {
  const matches = table.ops.filter((op) => op.label.endsWith(labelSuffix));
  if (matches.length === 1) return matches[0]!;
  const found = matches.map((op) => op.label).join(", ");
  throw new Error(
    `Expected exactly 1 op matching suffix ${labelSuffix}, found ${matches.length} (${found})`,
  );
};

const buildHandlers = ({
  table,
  overridesByLabelSuffix,
}: {
  table: ParsedEffectTable;
  overridesByLabelSuffix: Record<string, (...args: unknown[]) => unknown>;
}): Record<string, (...args: unknown[]) => unknown> => {
  const handlers = Object.fromEntries(
    table.ops.map((op) => [
      handlerKeyFor(op),
      () => {
        throw new Error(`unexpected effect in smoke test: ${op.label}`);
      },
    ]),
  ) as Record<string, (...args: unknown[]) => unknown>;

  Object.entries(overridesByLabelSuffix).forEach(([suffix, handler]) => {
    const op = findUniqueOpByLabelSuffix(table, suffix);
    handlers[handlerKeyFor(op)] = handler;
  });

  return handlers;
};

describe("smoke: effects host boundary", () => {
  let compiled: Awaited<ReturnType<ReturnType<typeof createSdk>["compile"]>>;
  let effectTable: ParsedEffectTable;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = await sdk.compile({ entryPath: fixtureEntryPath });
    assertNoCompileErrors(compiled.diagnostics);
    effectTable = parseEffectTable(compiled.wasm);
  });

  it("runs effect polymorphism where a pure function accepts effectful callbacks", async () => {
    const output = await compiled.run<number>({ entryName: "main" });
    expect(output).toBe(15);
  });

  it("runs an effectful export that resumes across a call boundary (Async.await)", async () => {
    const handlers = buildHandlers({
      table: effectTable,
      overridesByLabelSuffix: {
        "Async.await": (value: unknown): number => {
          if (typeof value !== "number") {
            throw new Error(
              `expected Async.await arg to be a number, got ${typeof value}`,
            );
          }
          return value + 1;
        },
      },
    });

    const output = await compiled.run<number>({
      entryName: "host_boundary_basic",
      handlers,
    });

    expect(output).toBe(1222);
  });

  it("runs tail effects across the host boundary (Async.await_tail)", async () => {
    const awaitOp = findUniqueOpByLabelSuffix(effectTable, "Async.await");
    const awaitTailOp = findUniqueOpByLabelSuffix(effectTable, "Async.await_tail");
    expect(awaitOp.resumeKind).not.toBe(awaitTailOp.resumeKind);

    const handlers = buildHandlers({
      table: effectTable,
      overridesByLabelSuffix: {
        "Async.await_tail": (value: unknown): number => {
          if (typeof value !== "number") {
            throw new Error(
              `expected Async.await_tail arg to be a number, got ${typeof value}`,
            );
          }
          return value + 3;
        },
      },
    });

    const output = await compiled.run<number>({
      entryName: "host_boundary_tail",
      handlers,
    });

    expect(output).toBe(20);
  });

  it("runs a multi-effect function (Async, IO, Log) -> void", async () => {
    const logs: number[] = [];
    const handlers = buildHandlers({
      table: effectTable,
      overridesByLabelSuffix: {
        "Async.await": (value: unknown): number => {
          if (typeof value !== "number") {
            throw new Error(
              `expected Async.await arg to be a number, got ${typeof value}`,
            );
          }
          return value + 1;
        },
        "IO.read": (): number => 3,
        "Log.info": (msg: unknown): void => {
          if (typeof msg !== "number") {
            throw new Error(
              `expected Log.info arg to be a number, got ${typeof msg}`,
            );
          }
          logs.push(msg);
        },
      },
    });

    const output = await compiled.run<unknown>({
      entryName: "host_boundary_multi",
      handlers,
    });

    expect(output).toBe(null);
    expect(logs).toEqual([14]);
  });

  it("supports generic effect propagation through callbacks", async () => {
    const logs: number[] = [];
    const handlers = buildHandlers({
      table: effectTable,
      overridesByLabelSuffix: {
        "Async.await": (value: unknown): number => {
          if (typeof value !== "number") {
            throw new Error(
              `expected Async.await arg to be a number, got ${typeof value}`,
            );
          }
          return value + 1;
        },
        "Log.info": (msg: unknown): void => {
          if (typeof msg !== "number") {
            throw new Error(
              `expected Log.info arg to be a number, got ${typeof msg}`,
            );
          }
          logs.push(msg);
        },
      },
    });

    const output = await compiled.run<number>({
      entryName: "host_boundary_generic",
      handlers,
    });

    expect(output).toBe(6);
    expect(logs).toEqual([6]);
  });
});
