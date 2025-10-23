import { IdentifierAtom } from "./atom.js";
import { Expr } from "./expr.js";
import { Form } from "./form.js";
import { FormCursor } from "./form-cursor.js";
import { is } from "./syntax.js";

const isDelimiter = (expr: Expr | undefined, value: string) =>
  is(expr, IdentifierAtom) && expr.value === value;

export const elementsOf = (form?: Form): Expr[] => {
  if (!form) return [];
  const cursor = FormCursor.fromForm(form);
  const elements: Expr[] = [];
  while (!cursor.done) {
    const expr = cursor.consume();
    if (expr) elements.push(expr);
  }
  return elements;
};

export const splitOnDelimiter = (form: Form, delimiter = ","): Expr[][] => {
  const cursor = FormCursor.fromForm(form);
  const groups: Expr[][] = [];
  let current: Expr[] = [];

  while (!cursor.done) {
    const next = cursor.peek();
    if (isDelimiter(next, delimiter)) {
      cursor.consume();
      if (current.length) groups.push(current);
      current = [];
      continue;
    }

    const expr = cursor.consume();
    if (!expr) break;
    current.push(expr);
  }

  if (current.length) groups.push(current);
  return groups;
};

export const takeUntilDelimiter = (
  cursor: FormCursor,
  delimiter = ","
): Expr[] => {
  const items: Expr[] = [];
  while (!cursor.done) {
    const next = cursor.peek();
    if (isDelimiter(next, delimiter)) break;
    const expr = cursor.consume();
    if (!expr) break;
    items.push(expr);
  }
  return items;
};

export const consumeDelimiter = (cursor: FormCursor, delimiter = ",") => {
  if (isDelimiter(cursor.peek(), delimiter)) {
    cursor.consume();
    return true;
  }
  return false;
};

export const getCallArgsForm = (form: Form | undefined): Form | undefined => {
  if (!form) return undefined;
  const second = form.at(1);
  return is(second, Form) ? second : undefined;
};

export const updateCallArgs = (
  call: Form,
  transform: (args: Form) => Form
): Form => {
  const argsForm = getCallArgsForm(call) ?? new Form();
  const nextArgs = transform(argsForm);
  const elements = call.toArray();
  const nextElements =
    elements.length >= 2
      ? [elements[0]!, nextArgs, ...elements.slice(2)]
      : [elements[0]!, nextArgs];

  const result = new Form({
    elements: nextElements,
    location: call.location,
  });

  if (argsForm.location && nextArgs.location === argsForm.location) {
    nextArgs.setLocation(argsForm.location.clone());
  }

  return result;
};
