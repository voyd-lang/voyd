const te = new TextEncoder();
const td = new TextDecoder();

class Writer {
  private view: DataView;
  constructor(private buf: Uint8Array, public offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private ensure(n: number) {
    if (this.offset + n > this.buf.length) throw new RangeError("msgpack: out of range");
  }
  private u8(b: number) {
    this.ensure(1);
    this.buf[this.offset++] = b;
  }
  private i8(n: number) {
    this.ensure(1);
    this.view.setInt8(this.offset, n);
    this.offset += 1;
  }
  private u16(n: number) {
    this.ensure(2);
    this.view.setUint16(this.offset, n);
    this.offset += 2;
  }
  private i16(n: number) {
    this.ensure(2);
    this.view.setInt16(this.offset, n);
    this.offset += 2;
  }
  private u32(n: number) {
    this.ensure(4);
    this.view.setUint32(this.offset, n);
    this.offset += 4;
  }
  private i32(n: number) {
    this.ensure(4);
    this.view.setInt32(this.offset, n);
    this.offset += 4;
  }
  private f64(n: number) {
    this.ensure(8);
    this.view.setFloat64(this.offset, n);
    this.offset += 8;
  }
  private bytes(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.offset);
    this.offset += bytes.length;
  }
  write(value: any) {
    if (value === null) {
      this.u8(0xc0);
    } else if (value === true) {
      this.u8(0xc3);
    } else if (value === false) {
      this.u8(0xc2);
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        if (value >= 0 && value <= 0x7f) {
          this.u8(value);
        } else if (value >= -32 && value < 0) {
          this.u8(0xe0 | (value + 32));
        } else if (value >= -128 && value <= 127) {
          this.u8(0xd0);
          this.i8(value);
        } else if (value >= -32768 && value <= 32767) {
          this.u8(0xd1);
          this.i16(value);
        } else if (value >= -2147483648 && value <= 2147483647) {
          this.u8(0xd2);
          this.i32(value);
        } else {
          this.u8(0xcb);
          this.f64(value);
        }
      } else {
        this.u8(0xcb);
        this.f64(value);
      }
    } else if (typeof value === "string") {
      const encoded = te.encode(value);
      const len = encoded.length;
      if (len < 32) {
        this.u8(0xa0 | len);
      } else if (len < 256) {
        this.u8(0xd9);
        this.u8(len);
      } else if (len < 65536) {
        this.u8(0xda);
        this.u16(len);
      } else {
        this.u8(0xdb);
        this.u32(len);
      }
      this.bytes(encoded);
    } else if (Array.isArray(value)) {
      const len = value.length;
      if (len < 16) {
        this.u8(0x90 | len);
      } else {
        this.u8(0xdc);
        this.u16(len);
      }
      for (const el of value) this.write(el);
    } else if (typeof value === "object") {
      const keys = Object.keys(value);
      const len = keys.length;
      if (len < 16) {
        this.u8(0x80 | len);
      } else {
        this.u8(0xde);
        this.u16(len);
      }
      for (const k of keys) {
        this.write(k);
        this.write(value[k]);
      }
    } else {
      throw new Error("Unsupported type");
    }
  }
}

class Reader {
  private view: DataView;
  constructor(private buf: Uint8Array, public offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private u8() {
    return this.buf[this.offset++];
  }
  private i8() {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }
  private u16() {
    const v = this.view.getUint16(this.offset);
    this.offset += 2;
    return v;
  }
  private i16() {
    const v = this.view.getInt16(this.offset);
    this.offset += 2;
    return v;
  }
  private u32() {
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }
  private i32() {
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }
  private f64() {
    const v = this.view.getFloat64(this.offset);
    this.offset += 8;
    return v;
  }
  private bytes(len: number) {
    const b = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return b;
  }
  private str(len: number) {
    return td.decode(this.bytes(len));
  }
  private arr(len: number) {
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = this.read();
    return out;
  }
  private map(len: number) {
    const out: any = {};
    for (let i = 0; i < len; i++) {
      const k = this.read();
      const v = this.read();
      out[k] = v;
    }
    return out;
  }
  read(): any {
    const b = this.u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0xa0 && b <= 0xbf) return this.str(b & 0x1f);
    if (b >= 0x90 && b <= 0x9f) return this.arr(b & 0x0f);
    if (b >= 0x80 && b <= 0x8f) return this.map(b & 0x0f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xd0:
        return this.i8();
      case 0xd1:
        return this.i16();
      case 0xd2:
        return this.i32();
      case 0xcb:
        return this.f64();
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.arr(this.u16());
      case 0xdd:
        return this.arr(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
      default:
        throw new Error("Unsupported type 0x" + b.toString(16));
    }
  }
}

export function encodeTo(value: any, buf: Uint8Array, offset = 0): number {
  const w = new Writer(buf, offset);
  w.write(value);
  return w.offset - offset;
}

export function encode(value: any): Uint8Array {
  let buf = new Uint8Array(128);
  for (;;) {
    try {
      const len = encodeTo(value, buf, 0);
      return buf.subarray(0, len);
    } catch (e) {
      if (e instanceof RangeError) {
        buf = new Uint8Array(buf.length * 2);
        continue;
      }
      throw e;
    }
  }
}

export function decodeFrom(buf: Uint8Array, offset: number, len: number): any {
  const r = new Reader(buf.subarray(offset, offset + len));
  return r.read();
}

export function decode(buf: Uint8Array): any {
  const r = new Reader(buf);
  return r.read();
}

