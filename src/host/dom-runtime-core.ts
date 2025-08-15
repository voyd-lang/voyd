// Binary patch executor shared by Node and browser targets.
// Strings are carried inline as (len|LEB128, bytes...)

export type NodeHandle = number;
export interface DomEnv {
  document: Document;
}

export class DomRuntime {
  private H = new Map<NodeHandle, Node>();
  private dec = new TextDecoder();

  constructor(root: Element) {
    this.H.set(1, root); // reserve hid=1 for mount root
  }

  applyPatchFrame(bytes: Uint8Array) {
    const i = { idx: 0 };
    const readU32 = () => {
      let x = 0,
        s = 0,
        b;
      do {
        b = bytes[i.idx++];
        x |= (b & 0x7f) << s;
        s += 7;
      } while (b & 0x80);
      return x >>> 0;
    };
    const readStr = () => {
      const L = readU32();
      const s = this.dec.decode(bytes.subarray(i.idx, i.idx + L));
      i.idx += L;
      return s;
    };

    while (i.idx < bytes.length) {
      const op = readU32();
      if (op === 1) {
        // CREATE_EL(hid, tag)
        const hid = readU32();
        const tag = readStr();
        this.H.set(hid, document.createElement(tag));
      } else if (op === 2) {
        // CREATE_TEXT(hid, text)
        const hid = readU32();
        const text = readStr();
        this.H.set(hid, document.createTextNode(text));
      } else if (op === 3) {
        // SET_TEXT(hid, text)
        const hid = readU32();
        const text = readStr();
        const n = this.H.get(hid) as CharacterData | null;
        if (n) n.textContent = text;
      } else if (op === 4) {
        // APPEND(parent, child)
        const p = this.H.get(readU32());
        const c = this.H.get(readU32());
        if (p && c) p.appendChild(c);
      } else if (op === 5) {
        // SET_ATTR(hid, name, value)
        const hid = readU32();
        const name = readStr();
        const value = readStr();
        (this.H.get(hid) as Element | null)?.setAttribute(name, value);
      } else if (op === 6) {
        // SET_STYLE(hid, name, value)
        const hid = readU32();
        const name = readStr();
        const value = readStr();
        (this.H.get(hid) as HTMLElement | null)?.style.setProperty(name, value);
      } else if (op === 7) {
        // INSERT_BEFORE(parent, child, ref|0)
        const p = this.H.get(readU32());
        const c = this.H.get(readU32());
        const r = readU32();
        (p as Node).insertBefore(c!, r ? this.H.get(r)! : null);
      } else if (op === 8) {
        // REMOVE(hid)
        const n = this.H.get(readU32());
        if (n && n.parentNode) n.parentNode.removeChild(n);
      } else if (op === 9) {
        // ADD_EVENT(hid, type, listenerId, flags)
        const hid = readU32();
        const type = readStr();
        const listenerId = readU32();
        const flags = readU32();
        const node = this.H.get(hid)! as Element;
        const listener = (ev: Event) =>
          this.onDomEvent(listenerId, hid, type, ev);
        // store for removal in a real impl
        node.addEventListener(type, listener, {
          capture: !!(flags & 1),
          passive: !!(flags & 2),
        });
      } else if (op === 10) {
        // REMOVE_EVENT(hid, type, listenerId)
        // left as exercise: look up listener and remove
        readU32();
        readStr();
        readU32();
      } else {
        throw new Error("Unknown op " + op);
      }
    }
  }

  // Hook this from outside to deliver events back to Wasm
  onDomEvent(listenerId: number, hid: number, type: string, ev: Event) {
    // no-op default; the host will override and serialize via MessagePack
  }
}
