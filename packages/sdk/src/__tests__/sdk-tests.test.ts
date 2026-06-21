import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult, type TestEvent } from "@voyd-lang/sdk";

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("sdk tests collection", { timeout: 120_000 }, () => {
  it("invalidates compile reuse when a companion test file changes", async () => {
    const sdk = createSdk();
    const compile = (description: string) =>
      sdk.compile({
        includeTests: true,
        entryPath: "main.voyd",
        source: `pub fn main() -> i32
  1
`,
        files: {
          "main.test.voyd": `test "${description}":
  1
`,
        },
      });

    const first = expectCompileSuccess(await compile("first companion test"));
    expect(first.tests?.cases.map((test) => test.description)).toEqual([
      "first companion test",
    ]);

    const second = expectCompileSuccess(await compile("updated companion test"));
    expect(second.tests?.cases.map((test) => test.description)).toEqual([
      "updated companion test",
    ]);
  });

  it("keeps explicit boundary export includes scoped to the runnable module", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({
      includeTests: true,
      boundaryExports: { include: ["main"] },
      source: `pub fn main() -> i32
  42

test "passes":
  1
`,
    }));

    expect(result.tests?.cases.length).toBe(1);
    await expect(result.run({ entryName: "main" })).resolves.toBe(42);
  });

  it("discovers and runs tests", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({
      includeTests: true,
      source: `use std::msgpack::self as __std_msgpack
use std::string::self as __std_string

eff Test
  fail(resume) -> void
  skip(resume) -> void
  log(resume) -> void

test "passes":
  1

test skip "skipped by modifier":
  1

test "effect skip":
  Test::skip()

test only "only runs when respected":
  1
`,
    }));

    expect(result.tests).toBeDefined();
    expect(result.tests?.cases.length).toBe(4);
    expect(result.tests?.hasOnly).toBe(true);

    const events: TestEvent[] = [];
    const summary = await result.tests!.run({
      reporter: { onEvent: (event) => { events.push(event); } },
    });

    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(3);

    const resultEvents = events.filter(
      (event) => event.type === "test:result",
    );
    expect(resultEvents).toHaveLength(4);
    expect(events.some((event) => event.type === "discovery:start")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "discovery:complete")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "run:complete")).toBe(true);
  });
});
