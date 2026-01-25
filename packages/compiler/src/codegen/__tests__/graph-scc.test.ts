import { describe, it, expect } from "vitest";
import { getSccContainingRoot } from "../graph/scc.js";

describe("getSccContainingRoot", () => {
  it("returns only the root for an acyclic graph", () => {
    const graph = new Map<number, readonly number[]>([
      [1, [2]],
      [2, [3]],
      [3, []],
    ]);
    expect(
      getSccContainingRoot({ root: 1, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([1]);
    expect(
      getSccContainingRoot({ root: 2, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([2]);
    expect(
      getSccContainingRoot({ root: 3, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([3]);
  });

  it("returns the full SCC containing the root", () => {
    const graph = new Map<number, readonly number[]>([
      [1, [2]],
      [2, [1, 3]],
      [3, []],
    ]);
    expect(
      getSccContainingRoot({ root: 1, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([1, 2]);
    expect(
      getSccContainingRoot({ root: 2, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([1, 2]);
  });

  it("ignores SCCs not containing the root", () => {
    const graph = new Map<number, readonly number[]>([
      [1, [2]],
      [2, []],
      [3, [4]],
      [4, [3]],
    ]);
    expect(
      getSccContainingRoot({ root: 1, getDeps: (id) => graph.get(id) ?? [] }),
    ).toEqual([1]);
  });
});

