import { CallForm, Form, ParenForm } from "../ast/form.js";
import { Expr } from "../ast/expr.js";
import { idIs, is, tuple, WhitespaceAtom } from "../ast/index.js";
import { SourceLocation } from "../ast/syntax.js";
import { isOp } from "../grammar.js";

// Simplified and optimized version of functional notation parsing.
// Uses a single pass with a basic for-loop to minimize overhead.

type FunctionalNotationOptions = {
  allowParenTuple?: boolean;
};

export const functionalNotation = (
  list: Form,
  options: FunctionalNotationOptions = {}
): Form => {
  const allowParenTuple = options.allowParenTuple ?? true;
  const array = list.toArray();
  const result: Expr[] = [];

  let skip = 0;
  let isTuple = false;

  for (let index = 0; index < array.length; index++) {
    const expr = array[index];

    if (skip > 0) {
      skip--;
      continue;
    }

    if (is(expr, Form)) {
      result.push(functionalNotation(expr));
      continue;
    }

    if (is(expr, WhitespaceAtom)) {
      result.push(expr);
      continue;
    }

    const nextExpr = array[index + 1];

    if (nextExpr && is(nextExpr, Form) && !(isOp(expr) || idIs(expr, ","))) {
      if (is(nextExpr, CallForm) && nextExpr.calls("generics")) {
        const generics = nextExpr;
        const nextNextExpr = array[index + 2];
        if (is(nextNextExpr, Form)) {
          result.push(processGenerics(expr, generics, nextNextExpr));
          skip = 2;
        } else {
          result.push(processGenerics(expr, generics));
          skip = 1;
        }
      } else {
        const call = processParamList(expr, nextExpr);
        result.push(call);
        skip = 1;
      }
      continue;
    }

    if (allowParenTuple && is(list, ParenForm) && idIs(expr, ",")) {
      isTuple = true;
    }

    result.push(expr);
  }

  if (allowParenTuple && isTuple) {
    const tupleElements = result.filter(
      (expr) => !idIs(expr, ",") && !is(expr, WhitespaceAtom)
    );
    return tuple(...tupleElements).setLocation(list.location);
  }

  return recreateForm(list, result);
};

const processGenerics = (
  expr: Expr,
  generics: CallForm,
  params?: Form
): CallForm => {
  const processedGenerics = functionalNotation(generics);
  const args = params ? collectCallArguments(params) : [];
  return createCall(expr, [processedGenerics, ...args], params, generics);
};

const processParamList = (expr: Expr, params: Form): CallForm => {
  const args = collectCallArguments(params);
  return createCall(expr, args, params);
};

const collectCallArguments = (params: Form): Expr[] => {
  const argumentList = is(params, ParenForm)
    ? new Form({
        location: params.location?.clone(),
        elements: params.toArray(),
      })
    : params;

  const processed = functionalNotation(argumentList, {
    allowParenTuple: false,
  }).toArray();

  return processed.filter(
    (expr) => !idIs(expr, ",") && !is(expr, WhitespaceAtom)
  );
};

const recreateForm = (list: Form, elements: Expr[]): Form => {
  const Ctor = list.constructor as new (opts?: {
    location?: SourceLocation;
    elements?: Expr[];
  }) => Form;

  return new Ctor({
    location: list.location?.clone(),
    elements,
  });
};

const createCall = (
  callee: Expr,
  tail: Expr[],
  ...locationSources: (Expr | Form | undefined)[]
): CallForm => {
  const location = mergeLocations(callee, ...locationSources);
  return new CallForm({
    location,
    elements: [callee, ...tail],
  });
};

const mergeLocations = (
  ...sources: (Expr | Form | undefined)[]
): SourceLocation | undefined => {
  const locations = sources
    .map((source) => source?.location)
    .filter((loc): loc is SourceLocation => !!loc);

  if (locations.length === 0) return undefined;

  const merged = locations[0].clone();

  for (const location of locations.slice(1)) {
    if (location.startIndex < merged.startIndex) {
      merged.startIndex = location.startIndex;
      merged.startColumn = location.startColumn;
      merged.startLine = location.startLine;
    }

    if (location.endIndex > merged.endIndex) {
      merged.endIndex = location.endIndex;
      merged.endColumn = location.endColumn;
      merged.endLine = location.endLine;
    }
  }

  return merged;
};
