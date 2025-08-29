import { describe, test } from "vitest";
import { compile } from "../compiler.js";
import { msgPackMapVoyd } from "./fixtures/msg-pack-map.js";

describe("E2E msg pack Encoder with Map regression", () => {
  test.fails(
    "compiles Encoder with Map<MiniJson> without overload error",
    async () => {
      // Should NOT throw once resolver handles Map in MiniJson properly
      await compile(msgPackMapVoyd);
    }
  );
});
