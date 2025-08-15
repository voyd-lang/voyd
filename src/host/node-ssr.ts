import { JSDOM } from "jsdom";
import { DomRuntime } from "./dom-runtime-core.js";
import { VoydHost } from "./bindings.js";

export async function runSsr(wasmBytes: ArrayBuffer) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const document = dom.window.document;
  const root = document.getElementById("root")!;

  const runtime = new DomRuntime(root);

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

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const voyd = new VoydHost(instance.exports as any);

  // Wire event egress: serialize to MessagePack and call back into Wasm
  runtime.onDomEvent = (listenerId, hid, type, ev) => {
    const payload = voyd.mpPack({
      listenerId,
      hid,
      type,
      key: (ev as KeyboardEvent).key,
      button: (ev as MouseEvent).button,
      x: (ev as MouseEvent).clientX,
      y: (ev as MouseEvent).clientY,
      // add more as needed
    });
    const ptr = (instance.exports as any).voyd_get_scratch_ptr();
    const cap = (instance.exports as any).voyd_get_scratch_cap();
    if (payload.length > cap) throw new Error("scratch too small for event");
    new Uint8Array((instance.exports as any).memory.buffer).set(payload, ptr);
    (instance.exports as any).voyd_handle_event(ptr, payload.length);
  };

  // Kick off initial render
  (instance.exports as any).voyd_init(/*root_hid=*/ 1);

  return dom.serialize();
}
