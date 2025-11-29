import {
  type Expr,
  type Form,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { expectLabeledExpr, parseIfBranches, toSourceSpan } from "../../utils.js";
import { rememberSyntax } from "../context.js";
import { reportOverloadNameCollision } from "../overloads.js";
import type { BindingContext } from "../types.js";
import type { ScopeId } from "../../ids.js";
import { ensureForm } from "./utils.js";
import type { BinderScopeTracker } from "./scope-tracker.js";

export const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("block")) {
    bindBlock(expr, ctx, tracker);
    return;
  }

  if (expr.calls("if")) {
    bindIf(expr, ctx, tracker);
    return;
  }

  if (expr.calls("match")) {
    bindMatch(expr, ctx, tracker);
    return;
  }

  if (expr.calls("while")) {
    bindWhile(expr, ctx, tracker);
    return;
  }

  if (expr.calls("var") || expr.calls("let")) {
    bindVar(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindExpr(child, ctx, tracker);
  }
};

const bindBlock = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.enterScope(scope, () => {
    for (const child of form.rest) {
      bindExpr(child, ctx, tracker);
    }
  });
};

const bindIf = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const { branches, defaultBranch } = parseIfBranches(form);
  branches.forEach(({ condition, value }) => {
    bindExpr(condition, ctx, tracker);
    bindExpr(value, ctx, tracker);
  });

  if (defaultBranch) {
    bindExpr(defaultBranch, ctx, tracker);
  }
};

const bindMatch = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const operandExpr = form.at(1);
  const potentialBinder = form.at(2);
  const hasBinder = isIdentifierAtom(potentialBinder);
  const caseStartIndex = hasBinder ? 3 : 2;

  const matchScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, matchScope);

  tracker.enterScope(matchScope, () => {
    bindExpr(operandExpr, ctx, tracker);

    if (hasBinder) {
      rememberSyntax(potentialBinder as Syntax, ctx);
      reportOverloadNameCollision(
        potentialBinder.value,
        matchScope,
        potentialBinder,
        ctx
      );
      ctx.symbolTable.declare({
        name: potentialBinder.value,
        kind: "value",
        declaredAt: potentialBinder.syntaxId,
      });
    }

    for (let index = caseStartIndex; index < form.length; index += 1) {
      const arm = form.at(index);
      if (!isForm(arm) || !arm.calls(":")) {
        throw new Error("match cases must be labeled with ':'");
      }

      const caseScope = ctx.symbolTable.createScope({
        parent: matchScope,
        kind: "block",
        owner: arm.syntaxId,
      });
      ctx.scopeByNode.set(arm.syntaxId, caseScope);

      tracker.enterScope(caseScope, () => {
        const valueExpr = arm.at(2);
        bindExpr(valueExpr, ctx, tracker);
      });
    }
  });
};

const bindWhile = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const condition = form.at(1);
  if (!condition) {
    throw new Error("while expression missing condition");
  }

  const body = expectLabeledExpr(form.at(2), "do", "while expression");

  bindExpr(condition, ctx, tracker);
  bindExpr(body, ctx, tracker);
};

const bindVar = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const assignment = ensureForm(
    form.at(1),
    "var statement expects an assignment"
  );
  if (!assignment.calls("=")) {
    throw new Error("var statement must be an assignment form");
  }

  const isVar = form.calls("var");
  const isLet = form.calls("let");
  const patternExpr = assignment.at(1);
  const initializer = assignment.at(2);
  declarePatternBindings(patternExpr, ctx, tracker.current(), {
    mutable: isVar && !isLet,
    declarationSpan: toSourceSpan(patternExpr as Syntax),
  });
  bindExpr(initializer, ctx, tracker);
};

const declarePatternBindings = (
  pattern: Expr | undefined,
  ctx: BindingContext,
  scope: ScopeId,
  options: { mutable?: boolean; declarationSpan?: ReturnType<typeof toSourceSpan> } = {}
): void => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_") {
      return;
    }
    const declarationSpan =
      options.declarationSpan ?? toSourceSpan(pattern);
    rememberSyntax(pattern, ctx);
    reportOverloadNameCollision(pattern.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: pattern.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
      metadata: {
        mutable: options.mutable ?? false,
        declarationSpan,
      },
    });
    return;
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    pattern.rest.forEach((entry) =>
      declarePatternBindings(entry, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(entry as Syntax),
      })
    );
    return;
  }

  if (isForm(pattern) && pattern.calls(":")) {
    const nameExpr = pattern.at(1);
    const typeExpr = pattern.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("typed pattern name must be an identifier");
    }
    rememberSyntax(nameExpr, ctx);
    rememberSyntax(typeExpr as Syntax, ctx);
    reportOverloadNameCollision(nameExpr.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: nameExpr.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
      metadata: {
        mutable: options.mutable ?? false,
        declarationSpan: options.declarationSpan ?? toSourceSpan(pattern),
      },
    });
    return;
  }

  throw new Error("unsupported pattern form in declaration");
};
