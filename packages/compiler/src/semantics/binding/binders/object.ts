import type { Expr } from "../../../parser/index.js";
import { isForm, isIdentifierAtom } from "../../../parser/index.js";
import { rememberSyntax } from "../context.js";
import type { ObjectFieldDecl, TypeParameterDecl } from "../../decls.js";
import type { ScopeId } from "../../ids.js";
import type { BindingContext } from "../types.js";
import type { ParsedObjectDecl } from "../parsing.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { inheritMemberVisibility } from "../../hir/index.js";

export const bindObjectDecl = (
  decl: ParsedObjectDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.base, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "object" },
  });

  const objectScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, objectScope);

  const typeParameters: TypeParameterDecl[] = [];
  const fields: ObjectFieldDecl[] = [];
  tracker.enterScope(objectScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });

    decl.fields.forEach((field) => {
      rememberSyntax(field.ast, ctx);
      rememberSyntax(field.name, ctx);
      rememberSyntax(field.typeExpr, ctx);

      const fieldSymbol = ctx.symbolTable.declare({
        name: field.name.value,
        kind: "value",
        declaredAt: field.ast.syntaxId,
        metadata: { entity: "field", owner: symbol },
      });

      fields.push({
        name: field.name.value,
        symbol: fieldSymbol,
        ast: field.ast,
        typeExpr: field.typeExpr,
        optional: field.optional,
        visibility: inheritMemberVisibility({
          ownerVisibility: decl.visibility,
          modifier: field.memberModifier,
        }),
      });
    });
  });

  ctx.decls.registerObject({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    baseTypeExpr: decl.base,
    fields,
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

export const resolveObjectDecl = (
  targetExpr: Expr,
  ctx: BindingContext,
  scope: ScopeId
) => {
  const identifier = (() => {
    if (isIdentifierAtom(targetExpr)) {
      return targetExpr;
    }
    if (!isForm(targetExpr)) {
      return undefined;
    }
    if (isIdentifierAtom(targetExpr.first)) {
      return targetExpr.first;
    }
    if (targetExpr.callsInternal("generics")) {
      const target = targetExpr.at(1);
      if (isIdentifierAtom(target)) {
        return target;
      }
      if (isForm(target) && isIdentifierAtom(target.first)) {
        return target.first;
      }
    }
    return undefined;
  })();
  if (!identifier) {
    return undefined;
  }
  const targetSymbol = ctx.symbolTable.resolve(identifier.value, scope);
  if (typeof targetSymbol !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(targetSymbol);
  if (
    record.kind !== "type" ||
    (record.metadata as { entity?: string } | undefined)?.entity !== "object"
  ) {
    return undefined;
  }
  return ctx.decls.getObject(record.id);
};
