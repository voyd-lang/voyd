import {
  FloatAtom,
  IdentifierAtom,
  IntAtom,
  InternalIdentifierAtom,
} from "./atom.js";
import { Expr } from "./expr.js";
import { CallForm, FormInitElements } from "./form.js";
import { Internal } from "./internals.js";

export const call = (
  fn: Internal | IdentifierAtom | InternalIdentifierAtom,
  ...args: FormInitElements
) =>
  new CallForm([
    typeof fn === "string" ? new InternalIdentifierAtom(fn) : fn,
    ...args,
  ]);

export const surfaceCall = (fn: string, ...args: FormInitElements) =>
  call(identifier(fn), ...args);

export const paren = (...args: FormInitElements) => call("paren", ...args);
export const tuple = (...args: FormInitElements) => call("tuple", ...args);

export const arrayLiteral = (...args: FormInitElements) =>
  call("array_literal", ...args);

export const objectLiteral = (...args: FormInitElements) =>
  call("object_literal", ...args);

export const label = (label: IdentifierAtom | string, value: Expr) =>
  call(new IdentifierAtom(":"), label, value);

export const identifier = (id: string) => new IdentifierAtom(id);

export const internal = (id: Internal) => new InternalIdentifierAtom(id);

export const int = (value: string | number, type: "i32" | "i64" = "i32") =>
  new IntAtom(String(value)).setType(type);

export const float = (value: string | number, type: "f32" | "f64" = "f64") =>
  new FloatAtom(String(value)).setType(type);

const appendUtf8Bytes = (bytes: number[], codePoint: number) => {
  if (codePoint <= 0x7f) {
    bytes.push(codePoint);
    return;
  }
  if (codePoint <= 0x7ff) {
    bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    return;
  }
  if (codePoint <= 0xffff) {
    bytes.push(
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f)
    );
    return;
  }
  bytes.push(
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f)
  );
};

const encodeUtf8Bytes = (value: string): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint =
          (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        appendUtf8Bytes(bytes, codePoint);
        i += 1;
        continue;
      }
      appendUtf8Bytes(bytes, 0xfffd);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      appendUtf8Bytes(bytes, 0xfffd);
      continue;
    }
    appendUtf8Bytes(bytes, code);
  }
  return bytes;
};

export const string = (value: string) => {
  const bytes = encodeUtf8Bytes(value).map((byte) => int(byte));
  return call("new_string", call("fixed_array_literal", ...bytes));
};
