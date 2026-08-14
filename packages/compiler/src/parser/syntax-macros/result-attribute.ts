import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { cloneAttributes } from "../ast/syntax.js";
import type { ResultIdentityAttribute } from "../../result-identity.js";
import type { StagedAccessAttribute } from "../../staged-access.js";
import type { BuilderAccessAttribute } from "../../builder-access.js";
import { transformFormSequence } from "./sequence-transform.js";
import type { SyntaxMacro } from "./types.js";

export const resultAttributeMacro: SyntaxMacro = (form) =>
  attachResultAttributes(form);

const attachResultAttributes = (form: Form): Form =>
  transformFormSequence({ form, transform: processSequence });

const processSequence = (
  elements: readonly Expr[],
  allowAttributes: boolean,
): { elements: Expr[]; changed: boolean } => {
  const result: Expr[] = [];
  let pendingResult: ResultIdentityAttribute | undefined;
  let pendingStaged: StagedAccessAttribute | undefined;
  let pendingBuilder: BuilderAccessAttribute | undefined;
  let changed = false;

  for (const element of elements) {
    const processed = isForm(element)
      ? attachResultAttributes(element)
      : element;
    if (processed !== element) changed = true;

    if (allowAttributes && isResultAttributeForm(processed)) {
      if (pendingResult) throw new Error("duplicate @result attribute");
      pendingResult = parseResultAttribute(processed);
      changed = true;
      continue;
    }
    if (allowAttributes && isStagedAttributeForm(processed)) {
      if (pendingStaged) throw new Error("duplicate @staged attribute");
      pendingStaged = parseStagedAttribute(processed);
      changed = true;
      continue;
    }
    if (allowAttributes && isBuilderAttributeForm(processed)) {
      if (pendingBuilder) throw new Error("duplicate @builder attribute");
      pendingBuilder = parseDestinationAttribute(processed, "builder");
      changed = true;
      continue;
    }

    if ((pendingResult || pendingStaged || pendingBuilder) && allowAttributes) {
      if (!isForm(processed) || !isFunctionDeclForm(processed)) {
        throw new Error("function contract attributes must precede a function");
      }
      const attributes = cloneAttributes(processed.attributes) ?? {};
      if (pendingResult && attributes.resultIdentity) {
        throw new Error("duplicate @result attribute");
      }
      if (pendingStaged && attributes.stagedAccess) {
        throw new Error("duplicate @staged attribute");
      }
      if (pendingBuilder && attributes.builderAccess) {
        throw new Error("duplicate @builder attribute");
      }
      if (pendingResult) attributes.resultIdentity = pendingResult;
      if (pendingStaged) attributes.stagedAccess = pendingStaged;
      if (pendingBuilder) attributes.builderAccess = pendingBuilder;
      processed.attributes = attributes;
      pendingResult = undefined;
      pendingStaged = undefined;
      pendingBuilder = undefined;
      changed = true;
    }

    result.push(processed);
  }

  if ((pendingResult || pendingStaged || pendingBuilder) && allowAttributes) {
    throw new Error("function contract attribute missing a function");
  }
  return { elements: result, changed };
};

const isResultAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isResultHead(expr.at(1));

const isStagedAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isStagedHead(expr.at(1));

const isBuilderAttributeForm = (expr: Expr): expr is Form =>
  isForm(expr) && expr.calls("@") && isBuilderHead(expr.at(1));

const isResultHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) return expr.value === "result";
  if (!isForm(expr)) return false;
  return isIdentifierAtom(expr.first) && expr.first.value === "result";
};

const isStagedHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) return expr.value === "staged";
  if (!isForm(expr)) return false;
  return isIdentifierAtom(expr.first) && expr.first.value === "staged";
};

const isBuilderHead = (expr?: Expr): boolean => {
  if (isIdentifierAtom(expr)) return expr.value === "builder";
  if (!isForm(expr)) return false;
  return isIdentifierAtom(expr.first) && expr.first.value === "builder";
};

const parseResultAttribute = (form: Form): ResultIdentityAttribute => {
  const target = form.at(1);
  if (!isForm(target) || !target.calls("result") || target.length !== 2) {
    throw new Error("@result requires exactly one identity argument");
  }
  const identity = target.at(1);
  if (!isIdentifierAtom(identity)) {
    throw new Error("@result identity must be 'detached' or 'fresh'");
  }
  if (identity.value !== "detached" && identity.value !== "fresh") {
    throw new Error(
      `unknown @result identity '${identity.value}'; expected 'detached' or 'fresh'`,
    );
  }
  return { kind: identity.value };
};

const parseStagedAttribute = (form: Form): StagedAccessAttribute => {
  return parseDestinationAttribute(form, "staged");
};

const parseDestinationAttribute = (
  form: Form,
  name: "staged" | "builder",
): { destinationParameterName: string } => {
  const target = form.at(1);
  if (!isForm(target) || !target.calls(name) || target.length !== 2) {
    throw new Error(`@${name} requires exactly one 'into:' argument`);
  }
  const argument = target.at(1);
  if (!isForm(argument) || !argument.calls(":") || argument.length !== 3) {
    throw new Error(`@${name} argument must be labeled 'into:'`);
  }
  const label = argument.at(1);
  if (!isIdentifierAtom(label) || label.value !== "into") {
    throw new Error(`@${name} argument must be labeled 'into:'`);
  }
  const destination = argument.at(2);
  if (!isIdentifierAtom(destination)) {
    throw new Error(`@${name} 'into:' value must name a parameter`);
  }
  return { destinationParameterName: destination.value };
};

const isFunctionDeclForm = (form: Form): boolean => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) return false;
  if (head.value === "fn") return true;
  if (!["pub", "api", "pri", "#"].includes(head.value)) return false;
  const keyword = form.at(1);
  return isIdentifierAtom(keyword) && keyword.value === "fn";
};
