import type { IdentifierAtom } from "../../parser/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { toSourceSpan } from "../utils.js";
import type { BindingContext } from "./types.js";

const upperCamelNamePattern = /^[A-Z][A-Za-z0-9]*$/;

const isUpperCamelTypeName = (name: string): boolean =>
  upperCamelNamePattern.test(name);

export const reportInvalidTypeDeclarationName = ({
  declarationKind,
  name,
  ctx,
}: {
  declarationKind: "type alias" | "obj" | "trait" | "effect";
  name: IdentifierAtom;
  ctx: BindingContext;
}): void => {
  if (isUpperCamelTypeName(name.value)) {
    return;
  }

  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0007",
      params: {
        kind: "invalid-type-name",
        declarationKind,
        name: name.value,
      },
      span: toSourceSpan(name),
    }),
  );
};
