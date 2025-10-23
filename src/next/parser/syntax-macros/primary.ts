import { InternalIdentifierAtom } from "../ast/atom.js";
import { Form } from "../ast/form.js";
import {
  Expr,
  FormCursor,
  IdentifierAtom,
  SourceLocation,
  is,
} from "../ast/index.js";
import {
  infixOps,
  isInfixOp,
  isPrefixOp,
  prefixOps,
} from "../grammar.js";

const flattenElements = (form: Form): Expr[] => {
  if (form.length === 2) {
    const first = form.at(0);
    const second = form.at(1);
    if (is(first, InternalIdentifierAtom) && is(second, Form)) {
      if (
        second.length === 2 &&
        is(second.at(0), InternalIdentifierAtom) &&
        is(second.at(1), Form)
      ) {
        return [
          first!,
          new Form({
            elements: flattenElements(second),
            location: second.location,
          }),
        ];
      }

      const args: Expr[] = [];
      for (const group of second.splitOnDelimiter()) {
        if (!group.length) continue;
        args.push(
          group.length === 1
            ? group[0]!
            : new Form({ elements: group, location: second.location })
        );
      }

      return [first!, ...args];
    }
  }

  return form.toArray();
};

// TODO: Update top location by between first child and end child (to replace dynamicLocation)
export const primary = (form: Form): Form => parseForm(form);

const parseExpression = (expr: Expr): Expr =>
  is(expr, Form) ? parseForm(expr) : expr;

const parseForm = (form: Form): Form => {
  const elements = flattenElements(form);
  const hadSingleFormChild = form.length === 1 && is(form.at(0), Form);

  if (!elements.length) {
    return new Form({ location: cloneLocation(form.location) });
  }

  const items: Expr[] = [];
  const cursor = new FormCursor(elements);

  while (!cursor.done) {
    items.push(parsePrecedence(cursor, 0, form.location));
  }

  let result: Form;
  if (!hadSingleFormChild && items.length && is(items[0], Form)) {
    const head = items[0] as Form;
    const rest = items.slice(1);
    result = new Form({
      elements: [...head.toArray(), ...rest],
      location: mergeLocations(form.location, head, ...rest),
    });
  } else {
    result = new Form({
      elements: items,
      location: mergeLocations(form.location, ...items),
    });
  }

  return restructureOperatorTail(result, form.location);
};

const parsePrecedence = (
  cursor: FormCursor,
  minPrecedence = 0,
  fallbackLocation?: SourceLocation
): Expr => {
  const first = cursor.peek();
  if (!first) {
    return new Form({ location: cloneLocation(fallbackLocation) });
  }

  let expr: Expr;

  if (isPrefixOp(first)) {
    const op = cursor.consume()!;
    const right = parsePrecedence(cursor, unaryOpInfo(op) ?? -1, fallbackLocation);
    expr = new Form({
      elements: [op, right],
      location: mergeLocations(fallbackLocation, op, right),
    });
  } else {
    expr = parseExpression(cursor.consume()!);
  }

  while (!cursor.done) {
    const op = cursor.peek();
    const precedence = infixOpInfo(op);
    if (precedence === undefined || precedence < minPrecedence) break;

    cursor.consume();
    const right = parsePrecedence(cursor, precedence + 1, fallbackLocation);

    expr = isDotOp(op)
      ? parseDot(expr, right, op, fallbackLocation)
      : new Form({
          elements: [op!, expr, right],
          location: mergeLocations(fallbackLocation, expr, op, right),
        });

    if (is(expr, Form) && isLambdaWithTupleArgs(expr)) {
      expr = removeTupleFromLambdaParameters(expr);
    }
  }

  return expr;
};

const isDotOp = (op?: Expr): op is IdentifierAtom =>
  is(op, IdentifierAtom) && op.value === ".";

const parseDot = (
  left: Expr,
  right: Expr,
  op: Expr | undefined,
  fallbackLocation?: SourceLocation
): Form => {
  const location = mergeLocations(fallbackLocation, left, op, right);

  if (is(right, Form) && right.calls("=>")) {
    return new Form({
      elements: ["call-closure", right, left],
      location,
    });
  }

  if (
    is(right, Form) &&
    is(right.at(1), Form) &&
    (right.at(1) as Form).callsInternal("generics")
  ) {
    const rightElements = right.toArray();
    return new Form({
      elements: [
        rightElements[0]!,
        rightElements[1]!,
        left,
        ...rightElements.slice(2),
      ],
      location,
    });
  }

  if (is(right, Form)) {
    const rightElements = right.toArray();
    return new Form({
      elements: [rightElements[0]!, left, ...rightElements.slice(1)],
      location,
    });
  }

  return new Form({
    elements: [right, left],
    location,
  });
};

const infixOpInfo = (op?: Expr): number | undefined => {
  if (!is(op, IdentifierAtom) || op.isQuoted) return undefined;
  return infixOps.get(op.value);
};

const unaryOpInfo = (op?: Expr): number | undefined => {
  if (!is(op, IdentifierAtom)) return undefined;
  return prefixOps.get(op.value);
};

const isLambdaWithTupleArgs = (form: Form) =>
  form.calls("=>") &&
  is(form.at(1), Form) &&
  (form.at(1) as Form).calls("tuple");

const removeTupleFromLambdaParameters = (form: Form): Form => {
  const params = form.at(1);
  if (!is(params, Form)) return form;

  const normalizedParams = new Form({
    elements: params.toArray().slice(1),
    location: params.location,
  });

  const elements = form.toArray();
  return new Form({
    elements: [elements[0]!, normalizedParams, ...elements.slice(2)],
    location: form.location,
  });
};

const restructureOperatorTail = (
  form: Form,
  fallbackLocation?: SourceLocation
): Form => {
  const op = form.at(0);
  if (
    !is(op, IdentifierAtom) ||
    !isInfixOp(op) ||
    op.isQuoted ||
    form.length <= 3
  ) {
    return form;
  }

  const left = form.at(1);
  if (!left) return form;

  const tailElements = form.toArray().slice(2);
  const tail = new Form({
    elements: tailElements,
    location: mergeLocations(form.location ?? fallbackLocation, ...tailElements),
  });

  const parsedTail = parseForm(tail);
  return new Form({
    elements: [op, left, parsedTail],
    location: mergeLocations(
      form.location ?? fallbackLocation,
      op,
      left,
      parsedTail
    ),
  });
};

const mergeLocations = (
  fallback: SourceLocation | undefined,
  ...sources: (Expr | SourceLocation | undefined)[]
): SourceLocation | undefined => {
  const locations = sources
    .map(getLocation)
    .filter((loc): loc is SourceLocation => !!loc);

  if (!locations.length) return cloneLocation(fallback);

  const first = locations[0]!.clone();
  const last = locations[locations.length - 1]!;
  first.setEndToEndOf(last);
  return first;
};

const getLocation = (source?: Expr | SourceLocation) => {
  if (!source) return undefined;
  return source instanceof SourceLocation ? source : source.location;
};

const cloneLocation = (loc?: SourceLocation) => loc?.clone();
