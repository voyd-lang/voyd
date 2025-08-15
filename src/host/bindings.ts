// Minimal host bindings to a core Wasm module produced by Voyd.
// - Provides helpers to read strings in chunks from Wasm (no per-char calls)
// - Provides MessagePack encode/decode glue over a scratch buffer

import { decode as msgpackDecode, encode as msgpackEncode } from "msgpackr";

export type VoydWasm = {
  memory: WebAssembly.Memory;
  // scratch buffer for bulk I/O
  voyd_get_scratch_ptr(): number;
  voyd_get_scratch_cap(): number;

  // String iteration over Voyd GC strings
  voyd_string_iter_start(h: number): number; // returns iter_id
  voyd_string_iter_fill(iter: number, dst_ptr: number, dst_cap: number): number; // bytes

  // MessagePack streaming (Voyd structs→bytes)
  voyd_mp_encode_start(rootHandle: number): number; // iter_id
  voyd_mp_encode_fill(iter: number, dst_ptr: number, dst_cap: number): number; // bytes

  // MessagePack one-shot decode into a new Voyd object/struct; returns handle
  voyd_mp_decode(ptr: number, len: number): number;

  // DOM rendering: Voyd calls host_apply_patch_frame(ptr,len) import
  // (declared here just so TS is aware)
};

export class VoydHost {
  private wasm!: VoydWasm;
  private memU8!: Uint8Array;
  private td = new TextDecoder();

  constructor(wasm: VoydWasm) {
    this.attach(wasm);
  }

  attach(wasm: VoydWasm) {
    this.wasm = wasm;
    this.memU8 = new Uint8Array(wasm.memory.buffer);
  }

  // Ensure we refresh the view if memory grows
  private view() {
    if (this.memU8.buffer !== this.wasm.memory.buffer) {
      this.memU8 = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.memU8;
  }

  /** Chunked read of a Voyd GC string using the iterator ABI */
  readVoydString(handle: number): string {
    const iter = this.wasm.voyd_string_iter_start(handle);
    const ptr = this.wasm.voyd_get_scratch_ptr();
    const cap = this.wasm.voyd_get_scratch_cap();
    let out = "";
    for (;;) {
      const n = this.wasm.voyd_string_iter_fill(iter, ptr, cap);
      if (n === 0) break;
      out += this.td.decode(this.view().subarray(ptr, ptr + n), {
        stream: true,
      });
    }
    out += this.td.decode();
    return out;
  }

  /** Encode a Voyd object/struct (by handle) to MessagePack bytes */
  mpEncode(handle: number): Uint8Array {
    const iter = this.wasm.voyd_mp_encode_start(handle);
    const ptr = this.wasm.voyd_get_scratch_ptr();
    const cap = this.wasm.voyd_get_scratch_cap();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = this.wasm.voyd_mp_encode_fill(iter, ptr, cap);
      if (n === 0) break;
      const chunk = this.view().slice(ptr, ptr + n);
      chunks.push(chunk);
      total += n;
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /** Decode MessagePack bytes into a Voyd struct on the Wasm side */
  mpDecodeToVoyd(bytes: Uint8Array): number {
    const ptr = this.wasm.voyd_get_scratch_ptr();
    const cap = this.wasm.voyd_get_scratch_cap();
    if (bytes.length > cap) throw new Error("scratch too small");
    this.view().set(bytes, ptr);
    return this.wasm.voyd_mp_decode(ptr, bytes.length);
  }

  /** Convenience for host-only payloads */
  mpPack(jsValue: any): Uint8Array {
    return msgpackEncode(jsValue);
  }
  mpUnpack(bytes: Uint8Array): any {
    return msgpackDecode(bytes);
  }
}
