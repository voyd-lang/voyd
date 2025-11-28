import { describe, test } from "vitest";
import { compile } from "../compiler.js";
import { msgPackMapVoyd } from "./fixtures/msg-pack-map.js";

describe("E2E msg pack Encoder with Map regression", () => {
  const timeout = 60000;

  test("compiles Encoder with Map<MsgPack> without overload error", { timeout }, async () => {
    // Should NOT throw once resolver handles Map in MsgPack properly
    await compile(msgPackMapVoyd);
  });
});
