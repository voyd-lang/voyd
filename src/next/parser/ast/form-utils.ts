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
