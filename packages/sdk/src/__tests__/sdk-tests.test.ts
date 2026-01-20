import { describe, expect, it } from "vitest";
import { createSdk, type TestEvent } from "@voyd/sdk";

describe("sdk tests collection", () => {
  it("discovers and runs tests", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({
      includeTests: true,
      source: `eff Test
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
    });

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
