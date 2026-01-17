import { describe, expect, it, vi } from "vitest";
import type { HostProtocolTable } from "../protocol/types.js";
import {
  buildHandlersByLabelSuffix,
  registerHandlersByLabelSuffix,
} from "../handlers.js";

const createTable = (): HostProtocolTable => ({
  version: 1,
  ops: [
    {
      opIndex: 0,
      effectId: "com.voyd.test",
      opId: 0,
      resumeKind: "resume",
      signatureHash: "0x1",
      label: "voyd.test.fail",
    },
    {
      opIndex: 1,
      effectId: "com.voyd.test",
      opId: 1,
      resumeKind: "resume",
      signatureHash: "0x2",
      label: "voyd.test.skip",
    },
    {
      opIndex: 2,
      effectId: "com.voyd.test",
      opId: 2,
      resumeKind: "resume",
      signatureHash: "0x3",
      label: "voyd.test.log",
    },
    {
      opIndex: 3,
      effectId: "com.voyd.other",
      opId: 0,
      resumeKind: "resume",
      signatureHash: "0x4",
      label: "voyd.test.fail",
    },
  ],
});

describe("buildHandlersByLabelSuffix", () => {
  it("selects the effect with the most matching labels", () => {
    const table = createTable();
    const handlersByLabelSuffix = {
      ".fail": () => "fail",
      ".skip": () => "skip",
      ".log": () => "log",
    };

    const matches = buildHandlersByLabelSuffix({
      table,
      handlersByLabelSuffix,
    });

    expect(matches).toHaveLength(3);
    expect(new Set(matches.map((match) => match.effectId))).toEqual(
      new Set(["com.voyd.test"])
    );
    expect(matches.map((match) => match.handler())).toEqual([
      "fail",
      "skip",
      "log",
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    const table = createTable();
    const matches = buildHandlersByLabelSuffix({
      table,
      handlersByLabelSuffix: { ".missing": () => null },
    });

    expect(matches).toEqual([]);
  });
});

describe("registerHandlersByLabelSuffix", () => {
  it("registers matching handlers on the host", () => {
    const table = createTable();
    const registerHandler = vi.fn();
    const handlersByLabelSuffix = {
      ".fail": () => "fail",
      ".skip": () => "skip",
      ".log": () => "log",
    };

    const count = registerHandlersByLabelSuffix({
      host: { table, registerHandler },
      handlersByLabelSuffix,
    });

    expect(count).toBe(3);
    expect(registerHandler).toHaveBeenCalledTimes(3);
    expect(registerHandler).toHaveBeenCalledWith(
      "com.voyd.test",
      0,
      "0x1",
      expect.any(Function)
    );
  });
});
