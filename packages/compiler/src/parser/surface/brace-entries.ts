import {
  type Expr,
  type Form,
  type IdentifierAtom,
  IdentifierAtom as IdentifierAtomNode,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { parseLambdaSignature } from "./lambda.js";
import { parseIfBranches, parseWhileConditionAndBody } from "./utils.js";
import { classifySurfaceForm } from "./form-classification.js";

/** Reader-to-surface marker for an ambiguous second field label on one line. */
export class PossibleMissingCommaField extends IdentifierAtomNode {}

export type SurfaceValueBraceEntry =
  | { kind: "field"; form: Form; name: IdentifierAtom; value: Expr }
  | { kind: "shorthand"; name: IdentifierAtom; value: IdentifierAtom }
  | { kind: "spread"; form: Form; value: Expr };

export type SurfaceRecordField = {
  form: Form;
  name: IdentifierAtom;
  value: Expr;
  optional: boolean;
};

const valueEntryCache = new WeakMap<Form, readonly SurfaceValueBraceEntry[]>();
const recordFieldCache = new WeakMap<Form, readonly SurfaceRecordField[]>();

export const assertNoMissingBraceEntryComma = (form: Form): void => {
  const candidate = form.rest
    .map((entry) =>
      isForm(entry) && (entry.calls(":") || entry.calls("?:"))
        ? findCandidateInValue(entry.at(2))
        : findCandidateInValue(entry),
    )
    .find((entry): entry is PossibleMissingCommaField => Boolean(entry));
  if (candidate) {
    throw new ParserSyntaxError(
      `Expected ',' before '${candidate.value}' in braces`,
      candidate.location,
    );
  }
};

const findCandidateInValue = (
  expr: Expr | undefined,
): PossibleMissingCommaField | undefined => {
  if (!expr) return undefined;
  if (expr instanceof PossibleMissingCommaField) return expr;
  if (!isForm(expr)) return undefined;
  const role = classifySurfaceForm(expr);
  if (role === "object") return undefined;
  if (role === "lambda") {
    parseLambdaSignature(expr.at(1));
    return findCandidateInValue(expr.at(2));
  }
  if (role === "if") {
    const parsed = parseIfBranches(expr);
    return [
      ...parsed.branches.map((branch) => branch.value),
      parsed.defaultBranch,
    ]
      .map(findCandidateInValue)
      .find((entry): entry is PossibleMissingCommaField => Boolean(entry));
  }
  if (role === "while") {
    return findCandidateInValue(parseWhileConditionAndBody(expr).body);
  }
  if (
    role === "match" ||
    role === "for" ||
    role === "try" ||
    role === "clause-container"
  ) {
    return expr.rest
      .map((child) =>
        isForm(child) && child.calls(":")
          ? findCandidateInValue(child.at(2))
          : findCandidateInValue(child),
      )
      .find((entry): entry is PossibleMissingCommaField => Boolean(entry));
  }
  return expr
    .toArray()
    .map(findCandidateInValue)
    .find((entry): entry is PossibleMissingCommaField => Boolean(entry));
};

export const parseValueBraceEntries = (
  form: Form,
  context = "object literal",
): readonly SurfaceValueBraceEntry[] => {
  const cached = valueEntryCache.get(form);
  if (cached) return cached;
  const parsed = form.rest.map((entry) => parseValueBraceEntry(entry, context));
  valueEntryCache.set(form, parsed);
  return parsed;
};

export const parseRecordFields = (
  form: Form,
  context = "object type",
): readonly SurfaceRecordField[] => {
  const cached = recordFieldCache.get(form);
  if (cached) return cached;
  const parsed = form.rest.map((entry) => {
    if (!isForm(entry) || (!entry.calls(":") && !entry.calls("?:"))) {
      throw syntaxError(`${context} fields must be labeled`, entry);
    }
    const name = entry.at(1);
    if (!isIdentifierAtom(name)) {
      throw syntaxError(`${context} field name must be an identifier`, entry);
    }
    const value = entry.at(2);
    if (!value) {
      throw syntaxError(`${context} field missing type expression`, entry);
    }
    return {
      form: entry,
      name,
      value,
      optional: entry.calls("?:"),
    };
  });
  recordFieldCache.set(form, parsed);
  return parsed;
};

const parseValueBraceEntry = (
  entry: Expr,
  context: string,
): SurfaceValueBraceEntry => {
  if (isForm(entry) && entry.calls("...")) {
    const value = entry.at(1);
    if (!value)
      throw syntaxError(`${context} spread entry missing value`, entry);
    return { kind: "spread", form: entry, value };
  }
  if (isForm(entry) && entry.calls(":")) {
    const name = entry.at(1);
    const value = entry.at(2);
    if (!isIdentifierAtom(name)) {
      throw syntaxError(`${context} field name must be an identifier`, entry);
    }
    if (!value) throw syntaxError(`${context} field missing value`, entry);
    return { kind: "field", form: entry, name, value };
  }
  if (isIdentifierAtom(entry)) {
    return { kind: "shorthand", name: entry, value: entry };
  }
  throw syntaxError(`unsupported ${context} entry`, entry);
};

const syntaxError = (message: string, expr: Expr): ParserSyntaxError =>
  new ParserSyntaxError(message, expr.location);
