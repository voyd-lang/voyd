import { DomRuntime } from "../dom-runtime-core.js";
import { VoydHost } from "../bindings.js";

(async () => {
  if (!document) return;
  const res = await fetch("/voyd.wasm");
  const wasmBytes = await res.arrayBuffer();

  const runtime = new DomRuntime(document.getElementById("root")!);

  const imports = {
    env: {
      host_apply_patch_frame: (ptr: number, len: number) => {
        const bytes = new Uint8Array(instance.exports.memory.buffer, ptr, len);
        runtime.applyPatchFrame(bytes);
      },
      host_log: (ptr: number, len: number) => {
        const u8 = new Uint8Array(instance.exports.memory.buffer, ptr, len);
        console.log(new TextDecoder().decode(u8));
      },
    },
  } as any;

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(wasmBytes),
    imports
  );
  const voyd = new VoydHost(instance.exports as any);

  runtime.onDomEvent = (listenerId, hid, type, ev) => {
    const payload = voyd.mpPack({ listenerId, hid, type });
    const ptr = (instance.exports as any).voyd_get_scratch_ptr();
    new Uint8Array((instance.exports as any).memory.buffer).set(payload, ptr);
    (instance.exports as any).voyd_handle_event(ptr, payload.length);
  };

  (instance.exports as any).voyd_init(1);
})();
