import type { IdentifierAtom } from "../../../parser/index.js";
import { rememberSyntax } from "../context.js";
import type { TypeParameterDecl } from "../decls.js";
import type { BindingContext } from "../types.js";

export const bindTypeParameters = (
  params: readonly IdentifierAtom[],
  ctx: BindingContext
): TypeParameterDecl[] =>
  params.map((param) => {
    rememberSyntax(param, ctx);
    const paramSymbol = ctx.symbolTable.declare({
      name: param.value,
      kind: "type-parameter",
      declaredAt: param.syntaxId,
    });
    return {
      name: param.value,
      symbol: paramSymbol,
      ast: param,
    };
  });
