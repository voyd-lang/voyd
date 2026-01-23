import type { Expr } from "./ast/index.js";

export type IntrinsicAttribute = {
  name?: string;
  usesSignature?: boolean;
};

export type SerializerAttribute = {
  formatId: string;
  encode: Expr;
  decode: Expr;
};

export type TestAttribute = {
  id: string;
  description?: string;
  modifiers?: {
    skip?: boolean;
    only?: boolean;
  };
};

export type EffectAttribute = {
  id?: string;
};
