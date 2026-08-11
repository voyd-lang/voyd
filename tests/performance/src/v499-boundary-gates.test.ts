import path from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost, type VoydHost } from "@voyd-lang/sdk/js-host";

const runPerf = process.env.VOYD_RUN_PERF_SMOKE === "1";
const perfDescribe = runPerf ? describe : describe.skip;
const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "v499-boundary-benchmark.voyd",
);

const gateMultiplier = Number.parseFloat(
  process.env.VOYD_V499_PERF_GATE_MULTIPLIER ?? "1",
);
const gate = (milliseconds: number): number => milliseconds * gateMultiplier;

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result;
};

type Measurement = {
  elapsedMs: number;
  peakHeapGrowthBytes: number;
  wasmMemoryGrowthBytes: number;
};

const measure = async ({
  host,
  run,
}: {
  host: VoydHost;
  run: () => Promise<unknown>;
}): Promise<Measurement> => {
  const memory = host.instance.exports.memory;
  const wasmBytesBefore =
    memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
  const heapBefore = process.memoryUsage().heapUsed;
  let peakHeapBytes = heapBefore;
  const sampler = setInterval(() => {
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  }, 1);
  const startedAt = performance.now();
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  const wasmBytesAfter =
    memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
  return {
    elapsedMs: performance.now() - startedAt,
    peakHeapGrowthBytes: Math.max(0, peakHeapBytes - heapBefore),
    wasmMemoryGrowthBytes: Math.max(0, wasmBytesAfter - wasmBytesBefore),
  };
};

perfDescribe("performance: V-499 DTO and host-boundary acceptance gates", () => {
  let host: VoydHost;
  let payload: {
    bytes: Uint8Array;
    values: number[];
    event: { $variant: "Item"; index: number };
    nested: { next: { next: { leaf: { value: number } } } };
  };

  beforeAll(async () => {
    const compiled = expectCompileSuccess(
      await createSdk().compile({ entryPath: fixtureEntryPath, optimize: false }),
    );
    expect(compiled.wasm.byteLength).toBeLessThan(10 * 1024 * 1024);
    host = await createVoydHost({ wasm: compiled.wasm, bufferSize: 1024 * 1024 });
    payload = {
      bytes: new Uint8Array(256 * 1024).fill(173),
      values: Array.from({ length: 16_384 }, (_, index) => index),
      event: { $variant: "Item", index: 16_383 },
      nested: { next: { next: { leaf: { value: 42 } } } },
    };
  }, 300_000);

  it("keeps large array, byte, deep-record, and variant host frames bounded", async () => {
    const measurement = await measure({
      host,
      run: async () => {
        const result = await host.runPure<typeof payload>("echo_payload", [payload]);
        expect(result.bytes).toBeInstanceOf(Uint8Array);
        expect(result.bytes.byteLength).toBe(payload.bytes.byteLength);
        expect(result.values.length).toBe(payload.values.length);
        expect(result.nested.next.next.leaf.value).toBe(42);
      },
    });
    expect(measurement.elapsedMs).toBeLessThan(gate(750));
    expect(measurement.peakHeapGrowthBytes).toBeLessThan(32 * 1024 * 1024);
    expect(measurement.wasmMemoryGrowthBytes).toBeLessThan(4 * 1024 * 1024);
  });

  it("keeps typed JSON and MessagePack streaming throughput bounded", async () => {
    const expectedSize = payload.bytes.length + payload.values.length;
    const json = await measure({
      host,
      run: async () => {
        await expect(
          host.runPure<number>("json_roundtrip_size", [payload.values]),
        ).resolves.toBe(payload.values.length);
      },
    });
    const msgpack = await measure({
      host,
      run: async () => {
        await expect(
          host.runPure<number>("msgpack_roundtrip_size", [payload]),
        ).resolves.toBe(expectedSize);
      },
    });
    expect(json.elapsedMs).toBeLessThan(gate(2_500));
    expect(msgpack.elapsedMs).toBeLessThan(gate(1_500));
    expect(json.peakHeapGrowthBytes).toBeLessThan(32 * 1024 * 1024);
    expect(msgpack.peakHeapGrowthBytes).toBeLessThan(32 * 1024 * 1024);
    expect(json.wasmMemoryGrowthBytes).toBeLessThan(4 * 64 * 1024);
    expect(msgpack.wasmMemoryGrowthBytes).toBeLessThan(4 * 64 * 1024);
  });

  it("keeps VX command batches and frequent event messages bounded", async () => {
    const batch = await measure({
      host,
      run: async () => {
        const encoded = await host.runPure<unknown>("command_batch", [1_000]);
        expect(encoded).toBeDefined();
      },
    });
    const events = await measure({
      host,
      run: async () => {
        for (let index = 0; index < 100; index += 1) {
          const encoded = await host.runPure<unknown>("event_frame", [index]);
          expect(encoded).toBeDefined();
        }
      },
    });
    expect(batch.elapsedMs).toBeLessThan(gate(1_500));
    expect(events.elapsedMs).toBeLessThan(gate(2_000));
    expect(batch.peakHeapGrowthBytes).toBeLessThan(16 * 1024 * 1024);
    expect(events.peakHeapGrowthBytes).toBeLessThan(64 * 1024 * 1024);
    expect(batch.wasmMemoryGrowthBytes).toBeLessThan(8 * 64 * 1024);
    expect(events.wasmMemoryGrowthBytes).toBeLessThan(8 * 64 * 1024);
  });
});
