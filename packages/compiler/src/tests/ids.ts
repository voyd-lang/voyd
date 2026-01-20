import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import type { ModulePath } from "../modules/types.js";
import { modulePathToString } from "../modules/path.js";
import {
  Form,
  type Expr,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";
import type { TestAttribute } from "../parser/attributes.js";

const TEST_PREFIX = "__test__";

export const hashModulePath = (path: ModulePath): string => {
  const moduleId = modulePathToString(path);
  const hash = murmurHash3(moduleId);
  return hash.toString(16).padStart(8, "0");
};

const parseTestSuffix = (id: string): string | undefined => {
  if (!id.startsWith(TEST_PREFIX)) {
    return undefined;
  }
  const remainder = id.slice(TEST_PREFIX.length);
  if (!remainder) {
    return undefined;
  }
  const match = remainder.match(/^[0-9a-f]{8}_(.+)$/i);
  return match ? match[1] : remainder;
};

const functionNameForm = (form: Form): Form | undefined => {
  if (form.calls("fn")) {
    const name = form.at(1);
    return isForm(name) ? name : undefined;
  }

  if (form.calls("pub")) {
    const keyword = form.at(1);
    if (isIdentifierAtom(keyword) && keyword.value === "fn") {
      const name = form.at(2);
      return isForm(name) ? name : undefined;
    }
  }

  return undefined;
};

const updateTestFunctionName = (form: Form, id: string): void => {
  const nameForm = functionNameForm(form);
  if (!nameForm) {
    return;
  }
  const nameAtom = nameForm.at(0);
  if (isIdentifierAtom(nameAtom) && nameAtom.value !== id) {
    nameAtom.value = id;
  }
};

const getTestAttribute = (form: Form): TestAttribute | undefined => {
  const attributes = form.attributes as { test?: TestAttribute } | undefined;
  if (!attributes?.test) {
    return undefined;
  }
  if (typeof attributes.test.id !== "string") {
    return undefined;
  }
  return attributes.test;
};

export const assignModuleTestIds = ({
  ast,
  modulePath,
}: {
  ast: Form;
  modulePath: ModulePath;
}): void => {
  const moduleHash = hashModulePath(modulePath);
  let counter = 0;

  const updateForm = (expr: Expr): void => {
    if (!isForm(expr)) {
      return;
    }

    const test = getTestAttribute(expr);
    if (test) {
      const startIndex = expr.location?.startIndex;
      const suffix =
        typeof startIndex === "number"
          ? `${startIndex}`
          : parseTestSuffix(test.id) ?? `${counter}`;
      const nextId = `${TEST_PREFIX}${moduleHash}_${suffix}`;
      if (test.id !== nextId) {
        test.id = nextId;
      }
      updateTestFunctionName(expr, nextId);
      counter += 1;
    }

    expr.toArray().forEach(updateForm);
  };

  updateForm(ast);
};
