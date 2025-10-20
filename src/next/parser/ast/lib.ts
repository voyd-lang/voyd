import { FloatAtom, IdentifierAtom, IntAtom } from "./atom.js";
import { Expr } from "./expr.js";
import {
  ArrayLiteralForm,
  CallForm,
  FormElementInitVal,
  LabelForm,
  ObjectLiteralForm,
  ParenForm,
  TupleForm,
} from "./form.js";
import { is } from "./index.js";

export const call = (
  fn: IdentifierAtom | string,
  ...args: FormElementInitVal
) => new CallForm([fn, ...args]);

export const paren = (...args: FormElementInitVal) => new ParenForm(args);

export const tuple = (...args: FormElementInitVal) => new TupleForm(args);

export const arrayLiteral = (...args: FormElementInitVal) =>
  new ArrayLiteralForm(args);

export const objectLiteral = (...args: LabelForm[]) =>
  new ObjectLiteralForm(args);

export const label = (label: IdentifierAtom | string, value: Expr) =>
  new LabelForm([label, value]);

export const identifier = (id: string) => new IdentifierAtom(id);

export const int = (value: string | number, type: "i32" | "i64" = "i32") =>
  new IntAtom(String(value)).setType(type);

export const float = (value: string | number, type: "f32" | "f64" = "f64") =>
  new FloatAtom(String(value)).setType(type);

export const string = (value: string) => {
  const codes = value.split("").map((c) => int(c.charCodeAt(0)));

  return call(
    "new_string",
    call(
      "object",
      label("from", call("FixedArray", call("generics", "i32"), ...codes))
    )
  );
};

export const idIs = (id?: unknown, value: string) =>
  is(id, IdentifierAtom) && id.value === value;
