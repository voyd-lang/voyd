import { JSDOM } from "jsdom";
import { DomRuntime } from "./dom-runtime-core.js";
import { VoydHost } from "./bindings.js";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOCK_WASM_BASE64 =
  "AGFzbQEAAAABEQRgAn9/AGAAAGABfwBgAAF/AiwCA2VudhZob3N0X2FwcGx5X3BhdGNoX2ZyYW1lAAADZW52Bm1lbW9yeQIAAQMGBQECAwMAB1gFBm1lbW9yeQIACXZveWRfaW5pdAACFHZveWRfZ2V0X3NjcmF0Y2hfcHRyAAMUdm95ZF9nZXRfc2NyYXRjaF9jYXAABBF2b3lkX2hhbmRsZV9ldmVudAAFCAEBChoFCABBAEETEAALAgALBABBAAsEAEEACwIACwsZAQBBAAsTAQICaDECAwVIZWxsbwQCAwQBAg==";

export async function runSsr(wasmBytes?: Uint8Array) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const document = dom.window.document;
  (globalThis as any).document = document;
  const root = document.getElementById("root")!;

  const runtime = new DomRuntime(root);

  let memory: WebAssembly.Memory;
  const imports = {
    env: {
      host_apply_patch_frame: (ptr: number, len: number) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        runtime.applyPatchFrame(bytes);
      },
      host_log: (ptr: number, len: number) => {
        const u8 = new Uint8Array(memory.buffer, ptr, len);
        console.log(new TextDecoder().decode(u8));
      },
    },
  } as any;

  let instance: WebAssembly.Instance;

  if (!wasmBytes) {
    const wasmPath = path.resolve("voyd.wasm");
    if (existsSync(wasmPath)) {
      wasmBytes = new Uint8Array(await fs.readFile(wasmPath));
    }
  }

  if (wasmBytes) {
    const instantiated: any = await WebAssembly.instantiate(
      wasmBytes,
      imports
    );
    instance = instantiated.instance;
    memory = (instance.exports as any).memory as WebAssembly.Memory;
  } else {
    memory = new WebAssembly.Memory({ initial: 1 });
    imports.env.memory = memory;
    const mockBytes = new Uint8Array(Buffer.from(MOCK_WASM_BASE64, "base64"));
    const module = new WebAssembly.Module(mockBytes);
    instance = new WebAssembly.Instance(module, imports);
  }

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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runSsr().then((html) => console.log(html));
}
