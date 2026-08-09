import { describe, expect, it } from "vitest";
import { parse } from "../../../parser/index.js";
import { DiagnosticError } from "../../../diagnostics/index.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("effect handler overload annotations", () => {
  it("requires annotations for overloaded operation handler parameters", () => {
    const source = `
eff Logger
  info(tail, value: i32) -> void
  info(tail, value: f64) -> void

pub fn main() -> i32
  try
    Logger::info(1)
  Logger::info(tail, value):
    tail()
  0
`;
    let caught: DiagnosticError | undefined;
    try {
      semanticsPipeline(
        parse(source, "/proj/src/effect-handler-overloads.voyd"),
      );
    } catch (error) {
      caught = error as DiagnosticError;
    }
    expect(caught?.diagnostic.code).toBe("TY0019");
  });

  it("rejects duplicate and colliding explicit operation host ids", () => {
    const duplicateIds = `
eff Store
  @operation(id: "read")
  fetch(tail, value: i32) -> i32
  @operation(id: "read")
  find(tail, value: i32) -> i32
`;
    const collidingFallback = `
eff Store
  @operation(id: "read")
  fetch(tail, value: i32) -> i32
  read(tail, value: i32) -> i32
`;
    [duplicateIds, collidingFallback].forEach((source) => {
      let caught: DiagnosticError | undefined;
      try {
        semanticsPipeline(
          parse(source, "/proj/src/operation-id-collision.voyd"),
        );
      } catch (error) {
        caught = error as DiagnosticError;
      }
      expect(caught?.diagnostic.code).toBe("BD0009");
      expect(caught?.diagnostic.message).toContain("host operation key read");
    });
  });
});
