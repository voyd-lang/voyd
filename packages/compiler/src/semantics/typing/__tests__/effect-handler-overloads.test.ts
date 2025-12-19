import { describe, expect, it } from "vitest";
import { parse } from "../../../parser/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("effect handler overload annotations", () => {
  it("requires handler annotations when overloads exist", () => {
    const source = `
eff Logger
  info(tail, v: i32) -> void
  info(tail, v: f64) -> void

pub fn main() -> i32
  try
    Logger::info(1)
  Logger::info(tail, v):
    tail()
  0
`;

    let caught: DiagnosticError | undefined;
    try {
      semanticsPipeline(parse(source, "/proj/src/effect-handler-overloads.voyd"));
    } catch (error) {
      caught = error as DiagnosticError;
    }

    expect(caught?.diagnostic.code).toBe("TY0019");
  });
});
