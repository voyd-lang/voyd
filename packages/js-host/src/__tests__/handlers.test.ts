import { describe, expect, it, vi } from "vitest";
import type {
  EffectContinuation,
  HostProtocolTable,
} from "../protocol/types.js";
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
      opName: "fail",
      resumeKind: "resume",
      signatureHash: "0x1",
      label: "voyd::test::fail",
    },
    {
      opIndex: 1,
      effectId: "com.voyd.test",
      opId: 1,
      opName: "skip",
      resumeKind: "resume",
      signatureHash: "0x2",
      label: "voyd::test::skip",
    },
    {
      opIndex: 2,
      effectId: "com.voyd.test",
      opId: 2,
      opName: "log",
      resumeKind: "resume",
      signatureHash: "0x3",
      label: "voyd::test::log",
    },
    {
      opIndex: 3,
      effectId: "com.voyd.other",
      opId: 0,
      opName: "fail",
      resumeKind: "resume",
      signatureHash: "0x4",
      label: "voyd::test::fail",
    },
  ],
});

describe("buildHandlersByLabelSuffix", () => {
  it("selects the effect with the most matching labels", async () => {
    const table = createTable();
    const handlersByLabelSuffix = {
      "test::fail": ({ end }: EffectContinuation) => end("fail"),
      "test::skip": ({ end }: EffectContinuation) => end("skip"),
      "test::log": ({ end }: EffectContinuation) => end("log"),
    };

    const matches = buildHandlersByLabelSuffix({
      table,
      handlersByLabelSuffix,
    });

    const continuation: EffectContinuation = {
      resume: (...args: unknown[]) => ({ kind: "resume", value: args[0] }),
      tail: (...args: unknown[]) => ({ kind: "tail", value: args[0] }),
      end: (value: unknown) => ({ kind: "end", value }),
    };

    expect(matches).toHaveLength(3);
    expect(new Set(matches.map((match) => match.effectId))).toEqual(
      new Set(["com.voyd.test"])
    );
    const calls = await Promise.all(
      matches.map((match) => Promise.resolve(match.handler(continuation)))
    );
    expect(calls.map((result) => result.value)).toEqual(["fail", "skip", "log"]);
  });

  it("returns an empty array when nothing matches", () => {
    const table = createTable();
    const matches = buildHandlersByLabelSuffix({
      table,
      handlersByLabelSuffix: { "::missing": ({ end }) => end(null) },
    });

    expect(matches).toEqual([]);
  });
});

describe("registerHandlersByLabelSuffix", () => {
  it("registers matching handlers on the host", () => {
    const table = createTable();
    const registerHandler = vi.fn();
    const handlersByLabelSuffix = {
      "test::fail": ({ end }: EffectContinuation) => end("fail"),
      "test::skip": ({ end }: EffectContinuation) => end("skip"),
      "test::log": ({ end }: EffectContinuation) => end("log"),
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
