import {
  type Expr,
  Form,
  IdentifierAtom,
  IntAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import { TestAttribute } from "../attributes.js";
import type { SyntaxMacro } from "./types.js";

type TestModifiers = {
  skip: boolean;
  only: boolean;
};

type ParsedTest = {
  description?: string;
  modifiers: TestModifiers;
  body: Form;
};

const parseStringLiteral = (expr?: Expr): string | null => {
  if (!expr) {
    return null;
  }

  if (
    !isForm(expr) ||
    (!expr.calls("new_string") && !expr.callsInternal("new_string"))
  ) {
    return null;
  }

  const rawValue = expr.at(1);
  if (!isForm(rawValue) || !formCallsInternal(rawValue, "object_literal")) {
    return null;
  }

  const fromField = rawValue.rest.find((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      return false;
    }
    const key = entry.at(1);
    return isIdentifierAtom(key) && key.value === "from";
  });

  if (!fromField || !isForm(fromField)) {
    return null;
  }

  const fromValue = fromField.at(2);
  if (!isForm(fromValue)) {
    return null;
  }

  const codes: number[] = [];
  fromValue.rest.forEach((entry, index) => {
    if (index === 0 && isForm(entry) && entry.callsInternal("generics")) {
      return;
    }

    if (entry instanceof IntAtom) {
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        codes.push(parsed);
      }
      return;
    }

    if (isIdentifierAtom(entry)) {
      const parsed = Number.parseInt(entry.value, 10);
      if (Number.isFinite(parsed)) {
        codes.push(parsed);
      }
    }
  });

  if (codes.length === 0) {
    return null;
  }

  return String.fromCharCode(...codes);
};

const parseTestForm = (form: Form): ParsedTest | null => {
  const head = form.at(0);
  if (!isIdentifierAtom(head) || head.value !== "test") {
    return null;
  }

  let index = 1;
  const modifiers: TestModifiers = { skip: false, only: false };

  while (index < form.length) {
    const entry = form.at(index);
    if (
      isIdentifierAtom(entry) &&
      (entry.value === "skip" || entry.value === "only")
    ) {
      modifiers[entry.value] = true;
      index += 1;
      continue;
    }
    break;
  }

  const clause = form.at(index);
  if (!isForm(clause) || !clause.calls(":")) {
    return null;
  }

  const block = clause.last;
  if (!isForm(block) || !block.calls("block")) {
    return null;
  }

  const label = clause.length >= 3 ? clause.at(1) : undefined;
  let description: string | undefined;

  if (label) {
    const parsed = parseStringLiteral(label);
    if (parsed !== null) {
      description = parsed;
    } else if (
      isIdentifierAtom(label) &&
      (label.value === "skip" || label.value === "only") &&
      !modifiers.skip &&
      !modifiers.only
    ) {
      modifiers[label.value] = true;
    }
  }

  return { description, modifiers, body: block };
};

const createTestFunction = ({
  form,
  parsed,
  id,
}: {
  form: Form;
  parsed: ParsedTest;
  id: string;
}): Form => {
  const fnForm = new Form({
    location: form.location?.clone(),
    elements: [
      new IdentifierAtom("pub"),
      new IdentifierAtom("fn"),
      new Form([new IdentifierAtom(id)]),
      parsed.body,
    ],
  });

  const attributes = cloneAttributes(form.attributes) ?? {};
  const testAttr: TestAttribute = {
    id,
    description: parsed.description,
    modifiers: parsed.modifiers,
  };
  attributes.test = testAttr;
  fnForm.attributes = attributes;
  return fnForm;
};

const nextTestId = (form: Form, counter: number): string => {
  const startIndex = form.location?.startIndex;
  if (typeof startIndex === "number") {
    return `__test__${startIndex}`;
  }
  return `__test__${counter}`;
};

export const testBlockMacro: SyntaxMacro = (form) => {
  if (!form.callsInternal("ast")) {
    return form;
  }

  let counter = 0;
  let didTransform = false;
  const transformed = form.rest.map((entry) => {
    if (!isForm(entry)) {
      return entry;
    }

    const parsed = parseTestForm(entry);
    if (!parsed) {
      return entry;
    }

    const id = nextTestId(entry, counter);
    counter += 1;
    didTransform = true;
    return createTestFunction({ form: entry, parsed, id });
  });

  if (!didTransform) {
    return form;
  }

  const rebuilt = new Form({
    location: form.location?.clone(),
    elements: [form.first!, ...transformed],
  }).toCall();
  rebuilt.attributes = cloneAttributes(form.attributes);
  return rebuilt;
};
