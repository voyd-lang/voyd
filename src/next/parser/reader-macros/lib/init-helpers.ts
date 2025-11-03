import {
  FloatAtom,
  IdentifierAtom,
  IntAtom,
  InternalIdentifierAtom,
} from "../../ast/atom.js";
import { Expr } from "../../ast/expr.js";
import { Form, FormInitElements } from "../../ast/form.js";

export const call = (
  fn: string | IdentifierAtom | InternalIdentifierAtom,
  ...args: FormInitElements
) =>
  new Form([
    typeof fn === "string" ? new InternalIdentifierAtom(fn) : fn,
    ...(args.length ? [new Form(separateWithCommas(args))] : []),
  ]);

export const prefixCall = (
  fn: string | IdentifierAtom | InternalIdentifierAtom,
  ...args: FormInitElements
) =>
  new Form([
    typeof fn === "string" ? new InternalIdentifierAtom(fn) : fn,
    ",",
    ...args,
  ]);

export const prefixParen = (...args: FormInitElements) =>
  prefixCall("paren", ...args);

export const prefixTuple = (...args: FormInitElements) =>
  prefixCall("tuple", ...args);

export const arrayLiteral = (...args: FormInitElements) =>
  call("array_literal", ...args);

export const prefixArrayLiteral = (...args: FormInitElements) =>
  prefixCall("array_literal", ...args);

export const objectLiteral = (...args: FormInitElements) =>
  call("object_literal", ...args);

export const prefixObjectLiteral = (...args: FormInitElements) =>
  prefixCall("object_literal", ...args);

export const label = (label: IdentifierAtom | string, value: Expr) =>
  call("label", label, value);

export const prefixLabel = (label: IdentifierAtom | string, value: Expr) =>
  prefixCall("label", label, value);

export const identifier = (id: string) => new IdentifierAtom(id);

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

const separateWithCommas = (values: FormInitElements): FormInitElements =>
  values.reduce<FormInitElements>((acc, value, index) => {
    acc.push(value);
    if (index < values.length - 1) acc.push(",");
    return acc;
  }, []);
