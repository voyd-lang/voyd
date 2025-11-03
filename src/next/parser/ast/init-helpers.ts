import {
  FloatAtom,
  IdentifierAtom,
  IntAtom,
  InternalIdentifierAtom,
} from "./atom.js";
import { Expr } from "./expr.js";
import { Form, FormInitElements } from "./form.js";
import { Internal } from "./internals.js";

export const call = (
  fn: Internal | IdentifierAtom | InternalIdentifierAtom,
  ...args: FormInitElements
) =>
  new Form([
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
  call("label", label, value);

export const identifier = (id: string) => new IdentifierAtom(id);

export const internal = (id: Internal) => new InternalIdentifierAtom(id);

export const int = (value: string | number, type: "i32" | "i64" = "i32") =>
  new IntAtom(String(value)).setType(type);

export const float = (value: string | number, type: "f32" | "f64" = "f64") =>
  new FloatAtom(String(value)).setType(type);

export const string = (value: string) => {
  const codes = value.split("").map((c) => int(c.charCodeAt(0)));

  return call(
    "new_string",
    objectLiteral(
      label(
        "from",
        call(identifier("FixedArray"), call("generics", "i32"), ...codes)
      )
    )
  );
};
