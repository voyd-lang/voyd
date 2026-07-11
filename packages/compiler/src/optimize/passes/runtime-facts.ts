import { type ProgramOptimizationPass } from "../pass.js";
import { exactNominalForType, exprTypeFor } from "./shared.js";

export const redundantRuntimeTypeCheckEliminationPass: ProgramOptimizationPass =
  {
    name: "redundant-runtime-type-check-elimination",
    run(ctx) {
      const ir = ctx.ir;
      let changed = false;
      let elidedChecks = 0;

      ir.modules.forEach((moduleView, moduleId) => {
        const candidates = new Set(
          ir.facts.runtimeTypeCheckElisionFieldAccesses.get(moduleId),
        );

        moduleView.hir.expressions.forEach((expr, exprId) => {
          if (expr.exprKind !== "field-access") {
            return;
          }

          const targetTypeId = exprTypeFor({ moduleView, exprId: expr.target });
          if (
            typeof exactNominalForType({
              typeId: targetTypeId,
              program: ir.baseProgram,
            }) !== "number"
          ) {
            return;
          }

          if (!candidates.has(exprId)) {
            candidates.add(exprId);
            changed = true;
            elidedChecks += 1;
          }
        });

        if (candidates.size > 0) {
          ctx.mutateProducedFacts((mutation) =>
            mutation.setFact(
              "runtimeTypeCheckElisionFieldAccesses",
              new Map([
                ...ctx.ir.facts.runtimeTypeCheckElisionFieldAccesses,
                [moduleId, candidates] as const,
              ]),
            ),
          );
        }
      });

      return { changed, metrics: { elided_checks: elidedChecks } };
    },
  };

export const semanticCopyForwardingPass: ProgramOptimizationPass = {
  name: "semantic-copy-forwarding",
  run(ctx) {
    const ir = ctx.ir;
    let changed = false;
    let forwardedFields = 0;

    ir.modules.forEach((moduleView, moduleId) => {
      const candidates = new Set(
        ir.facts.semanticCopyForwardingFieldAccesses.get(moduleId),
      );

      moduleView.hir.expressions.forEach((expr, exprId) => {
        if (expr.exprKind !== "field-access") {
          return;
        }

        const target = moduleView.hir.expressions.get(expr.target);
        if (
          target?.exprKind !== "object-literal" ||
          target.entries.some((entry) => entry.kind !== "field") ||
          !target.entries.some(
            (entry) => entry.kind === "field" && entry.name === expr.field,
          )
        ) {
          return;
        }

        if (!candidates.has(exprId)) {
          candidates.add(exprId);
          changed = true;
          forwardedFields += 1;
        }
      });

      if (candidates.size > 0) {
        ctx.mutateProducedFacts((mutation) =>
          mutation.setFact(
            "semanticCopyForwardingFieldAccesses",
            new Map([
              ...ctx.ir.facts.semanticCopyForwardingFieldAccesses,
              [moduleId, candidates] as const,
            ]),
          ),
        );
      }
    });

    return { changed, metrics: { forwarded_fields: forwardedFields } };
  },
};
