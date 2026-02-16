import { rememberSyntax } from "../context.js";
import type { TypeParameterDecl } from "../../decls.js";
import type { BindingContext } from "../types.js";
import type { ParsedTypeParameter } from "../parsing.js";

export const bindTypeParameters = (
  params: readonly ParsedTypeParameter[],
  ctx: BindingContext
): TypeParameterDecl[] =>
  params.map((param) => {
    rememberSyntax(param.name, ctx);
    rememberSyntax(param.constraint, ctx);
    const paramSymbol = ctx.symbolTable.declare({
      name: param.name.value,
      kind: "type-parameter",
      declaredAt: param.name.syntaxId,
    });
    return {
      name: param.name.value,
      symbol: paramSymbol,
      ast: param.name,
      constraint: param.constraint,
    };
  });
