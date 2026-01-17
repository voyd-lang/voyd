export type IntrinsicAttribute = {
  name?: string;
  usesSignature?: boolean;
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
