import { describe, expect, it } from "vitest";
import { executionPhases, testLanes } from "./run-test-suite.mjs";

const expectedLanes = [
  "release and test tooling",
  "workspace tests",
  "compiler codegen",
  "CLI source e2e",
  "CLI dist e2e",
];

describe("root test-suite orchestration", () => {
  it("uses resource-aware local phases and keeps CI fully sequential", () => {
    const localPhases = executionPhases({ isCi: false });
    const ciPhases = executionPhases({ isCi: true });

    expect(
      localPhases.map((phase) => phase.map(({ name }) => name)),
    ).toEqual([
      ["release and test tooling", "workspace tests"],
      ["compiler codegen", "CLI source e2e", "CLI dist e2e"],
    ]);
    expect(ciPhases.map(([lane]) => lane.name)).toEqual(expectedLanes);
    expect(ciPhases.every((phase) => phase.length === 1)).toBe(true);
  });

  it("forces every Turbo-backed test or build in the uncached suite", () => {
    const forcedLanes = testLanes({ force: true });
    const turboSteps = forcedLanes
      .flatMap(({ steps }) => steps)
      .filter(({ args }) => args.includes("turbo"));

    expect(turboSteps).toHaveLength(2);
    expect(turboSteps.every(({ args }) => args.includes("--force"))).toBe(true);
  });

  it("keeps source and built CLI execution explicit", () => {
    const lanes = testLanes();
    const sourceLane = lanes.find(({ name }) => name === "CLI source e2e");
    const distLane = lanes.find(({ name }) => name === "CLI dist e2e");

    expect(sourceLane.steps).toEqual([
      expect.objectContaining({ runtime: "source" }),
    ]);
    expect(distLane.steps.at(-1)).toEqual(
      expect.objectContaining({ runtime: "dist" }),
    );
  });
});
