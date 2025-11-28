import type { Expr, Form } from "../parser/index.js";
import {
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import type { HirGraph } from "./hir/index.js";
import { createHirBuilder } from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/lowering.js";
import { runTypingPipeline, type TypingResult } from "./typing/typing.js";
import { specializeOverloadCallees } from "./typing/specialize-overloads.js";
import { toSourceSpan } from "./utils.js";
import type { OverloadSetId, SymbolId } from "./ids.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
}

export const semanticsPipeline = (form: Form): SemanticsPipelineResult => {
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  const modulePath = form.location?.filePath ?? "<module>";
  const symbolTable: SymbolTable = new SymbolTable({
    rootOwner: form.syntaxId,
  });
  const moduleSymbol = symbolTable.declare({
    name: modulePath,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
  });
  ensureNoBindingErrors(binding);
  validateTraitImplSignatures(binding, symbolTable);

  const builder = createHirBuilder({
    path: modulePath,
    scope: moduleSymbol,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: form.syntaxId,
  });

  const typing = runTypingPipeline({
    symbolTable,
    hir,
    overloads: collectOverloadOptions(binding.overloads),
    decls: binding.decls,
  });

  specializeOverloadCallees(hir, typing);

  return { binding, symbolTable, hir, typing };
};

const validateTraitImplSignatures = (
  binding: BindingResult,
  symbolTable: SymbolTable
): void => {
  binding.impls.forEach((impl) => {
    if (!impl.trait) {
      return;
    }

    const implScope =
      binding.scopeByNode.get(impl.form?.syntaxId ?? impl.scope) ??
      symbolTable.rootScope;
    const traitInfo = resolveTraitFromSyntax(
      impl.trait,
      symbolTable,
      implScope,
      binding.decls
    );
    if (!traitInfo) {
      return;
    }

    const { traitDecl, traitName } = traitInfo;
    const implMethods = new Map(
      impl.methods.map((method) => [
        symbolTable.getSymbol(method.symbol).name,
        method,
      ])
    );
    const substitutions = buildTraitTypeSubstitutionsSyntax(
      traitDecl,
      impl.trait
    );
    const targetName = getSyntaxTypeName(impl.target, symbolTable, implScope);

    traitDecl.methods.forEach((traitMethod) => {
      if (traitMethod.defaultBody) return;
      const methodName = symbolTable.getSymbol(traitMethod.symbol).name;
      const implMethod = implMethods.get(methodName);
      if (!implMethod) return;

      if (traitMethod.params.length !== implMethod.params.length) {
        throw new Error(
          `impl ${traitName} for ${targetName} method ${methodName} has ${implMethod.params.length} parameter(s) but trait declares ${traitMethod.params.length}`
        );
      }

      const traitReturn = typeExprKey(
        traitMethod.returnTypeExpr,
        substitutions
      );
      const implReturn = typeExprKey(implMethod.returnTypeExpr);
      if (traitReturn && implReturn && traitReturn !== implReturn) {
        throw new Error(
          `impl ${traitName} for ${targetName} method ${methodName} return type mismatch: expected ${traitReturn}, got ${implReturn}`
        );
      }
    });
  });
};

const resolveTraitFromSyntax = (
  traitExpr: Expr,
  symbolTable: SymbolTable,
  scope: number,
  decls: BindingResult["decls"]
):
  | { traitDecl: BindingResult["decls"]["traits"][number]; traitName: string }
  | undefined => {
  const name = getTraitIdentifier(traitExpr);
  if (!name) return undefined;
  const traitSymbol = symbolTable.resolve(name, scope);
  if (typeof traitSymbol !== "number") return undefined;
  const traitDecl = decls.getTrait(traitSymbol);
  return traitDecl ? { traitDecl, traitName: name } : undefined;
};

const ensureNoBindingErrors = (binding: BindingResult): void => {
  const errors = binding.diagnostics.filter(
    (diag) => diag.severity === "error"
  );
  if (errors.length === 0) {
    return;
  }

  const message =
    errors.length === 1
      ? errors[0]!.message
      : errors
          .map(
            (diag) => `${diag.message} (${diag.span.file}:${diag.span.start})`
          )
          .join("\n");
  throw new Error(message);
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<OverloadSetId, BoundOverloadSet>
): Map<OverloadSetId, readonly SymbolId[]> =>
  new Map(
    Array.from(overloads.entries()).map(([id, set]) => [
      id,
      set.functions.map((fn) => fn.symbol),
    ])
  );

const getTraitIdentifier = (
  traitExpr: Expr | undefined
): string | undefined => {
  if (!traitExpr) return undefined;
  if (isIdentifierAtom(traitExpr)) return traitExpr.value;
  if (isForm(traitExpr) && isIdentifierAtom(traitExpr.first)) {
    return traitExpr.first.value;
  }
  if (
    isForm(traitExpr) &&
    formCallsInternal(traitExpr, "generics") &&
    isIdentifierAtom(traitExpr.second)
  ) {
    return traitExpr.second.value;
  }
  return undefined;
};

const getSyntaxTypeName = (
  expr: Expr | undefined,
  symbolTable: SymbolTable,
  scope: number
): string => {
  const name = getTraitIdentifier(expr);
  if (!name) return "impl target";
  const resolved = symbolTable.resolve(name, scope);
  if (typeof resolved === "number") {
    return symbolTable.getSymbol(resolved).name;
  }
  return name;
};

const buildTraitTypeSubstitutionsSyntax = (
  traitDecl: BindingResult["decls"]["traits"][number],
  traitExpr: Expr
): Map<string, string> | undefined => {
  const params = traitDecl.typeParameters ?? [];
  if (params.length === 0) return undefined;
  const args = extractTraitTypeArgumentsSyntax(traitExpr);
  if (args.length === 0) return undefined;

  const substitutions = new Map<string, string>();
  params.forEach((param, index) => {
    const key = typeExprKey(args[index]);
    if (key) substitutions.set(param.name, key);
  });
  return substitutions.size > 0 ? substitutions : undefined;
};

const extractTraitTypeArgumentsSyntax = (traitExpr: Expr): readonly Expr[] => {
  if (isForm(traitExpr) && isIdentifierAtom(traitExpr.first)) {
    if (
      isForm(traitExpr.second) &&
      formCallsInternal(traitExpr.second, "generics")
    ) {
      return traitExpr.second.rest;
    }
    return [];
  }

  if (isForm(traitExpr) && formCallsInternal(traitExpr, "generics")) {
    return traitExpr.rest;
  }

  return [];
};

const typeExprKey = (
  expr: Expr | undefined,
  substitutions?: Map<string, string>
): string | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr)) {
    return substitutions?.get(expr.value) ?? expr.value;
  }
  if (isForm(expr)) {
    if (expr.callsInternal("generics")) {
      const target = expr.at(1);
      const args = expr.rest.slice(1).map((arg) => typeExprKey(arg) ?? "_");
      return `${typeExprKey(target, substitutions)}<${args.join(",")}>`;
    }
    const head = typeExprKey(expr.first, substitutions);
    const rest = expr.rest.map(
      (entry) => typeExprKey(entry, substitutions) ?? "_"
    );
    return `${head ?? "?"}(${rest.join(",")})`;
  }
  return undefined;
};
