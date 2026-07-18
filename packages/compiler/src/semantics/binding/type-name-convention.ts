import type { IdentifierAtom } from "../../parser/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { toSourceSpan } from "../../parser/surface/utils.js";
import type { BindingContext } from "./types.js";

const upperCamelNamePattern = /^[A-Z][A-Za-z0-9]*$/;
const macroHygieneSuffixPattern = /(?:\$macro_id\$\d+)+$/;

const isUpperCamelTypeName = (name: string): boolean =>
  upperCamelNamePattern.test(name.replace(macroHygieneSuffixPattern, ""));

export const reportInvalidTypeDeclarationName = ({
  declarationKind,
  name,
  ctx,
}: {
  declarationKind: "type alias" | "obj" | "value" | "trait" | "effect";
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
