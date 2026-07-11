import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
} from "../../semantics/ids.js";
import { type ProgramOptimizationPass } from "../pass.js";
import type {
  CallShapeParameterState,
  CallShapeSpecializationRequest,
} from "../ir.js";
import { type ProgramOptimizationIR } from "../ir.js";
import {
  resolveCallArgPlan,
  buildInstanceCallSiteIndex,
  resolveTargetsForExactPropagation,
  receiverSpecializationCallSiteKey,
} from "./shared.js";

export type CallShapeCandidate = {
  callSiteKey: string;
  callerInstanceId: ProgramFunctionInstanceId;
  request: CallShapeSpecializationRequest;
};

export const callShapeParameterState = (
  entry: NonNullable<ReturnType<typeof resolveCallArgPlan>>[number],
): CallShapeParameterState =>
  entry.kind === "omitted-default" || entry.kind === "omitted-optional"
    ? "omitted"
    : entry.kind === "stable-callsite-id"
      ? "stable-callsite-id"
      : "provided";

export const serializeCallShapeSpecializationRequests = (
  requests: ReadonlyMap<
    string,
    ReadonlyMap<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
  >,
): string =>
  JSON.stringify(
    Array.from(requests.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([callSiteKey, byCaller]) => [
        callSiteKey,
        Array.from(byCaller.entries())
          .sort(([left], [right]) => left - right)
          .map(([callerInstanceId, request]) => [
            callerInstanceId,
            request.calleeInstanceId,
            request.keyTokens,
          ]),
      ]),
  );

export const collectCallShapeCandidates = ({
  ir,
}: {
  ir: ProgramOptimizationIR;
}): {
  candidates: CallShapeCandidate[];
  skipped: Readonly<Record<string, number>>;
} => {
  const candidates: CallShapeCandidate[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  buildInstanceCallSiteIndex({ ir }).forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      if (!callInfo || callInfo.traitDispatch) {
        skip("dynamic_or_unresolved");
        return;
      }
      const plan = resolveCallArgPlan({ callInfo, callerInstanceId });
      if (!plan) {
        skip("missing_typed_plan");
        return;
      }
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      }).filter(
        (
          target,
        ): target is typeof target & {
          instanceId: ProgramFunctionInstanceId;
        } => typeof target.instanceId === "number",
      );
      if (targets.length !== 1) {
        skip("non_unique_target");
        return;
      }
      const target = targets[0]!;
      const targetInstance = ir.baseProgram.functions.getInstance(
        target.instanceId,
      );
      const targetItem = ir.index.getFunction(
        targetInstance.symbolRef.moduleId,
        targetInstance.symbolRef.symbol,
      )?.item;
      const signature = ir.baseProgram.functions.getSignature(
        targetInstance.symbolRef.moduleId,
        targetInstance.symbolRef.symbol,
      );
      if (
        !targetItem ||
        !signature ||
        plan.length !== targetItem.parameters.length
      ) {
        skip("unsupported_target");
        return;
      }
      if (
        ir.baseProgram.symbols.getIntrinsicFunctionFlags(
          target.functionId as ProgramSymbolId,
        ).intrinsic
      ) {
        skip("intrinsic");
        return;
      }

      const states = plan.map(callShapeParameterState);
      const valid = states.every((state, index) => {
        const parameter = targetItem.parameters[index];
        const signatureParameter = signature.parameters[index];
        if (!parameter || !signatureParameter) {
          return false;
        }
        if (state === "provided") {
          return true;
        }
        if (state === "stable-callsite-id") {
          return (
            typeof parameter.defaultValue === "number" &&
            signatureParameter.synthetic === "stable-callsite-id"
          );
        }
        return (
          typeof parameter.defaultValue === "number" ||
          signatureParameter.optional === true
        );
      });
      if (!valid) {
        skip("invalid_plan");
        return;
      }
      const beneficial = states.some(
        (state, index) =>
          state !== "provided" ||
          typeof targetItem.parameters[index]?.defaultValue === "number",
      );
      if (!beneficial) {
        skip("identity_shape");
        return;
      }

      const keyTokens = Object.freeze(["v1", ...states]);
      candidates.push({
        callSiteKey: receiverSpecializationCallSiteKey({
          moduleId: moduleView.moduleId,
          exprId,
        }),
        callerInstanceId,
        request: Object.freeze({
          stage: "planned",
          identity: `${target.instanceId}:${keyTokens.join("|")}`,
          calleeInstanceId: target.instanceId,
          keyTokens,
        }),
      });
    });
  });

  return { candidates, skipped };
};

export const callShapeSpecializationPlanningPass: ProgramOptimizationPass = {
  name: "call-shape-specialization-planning",
  run(ctx) {
    const ir = ctx.ir;
    const { candidates, skipped } = collectCallShapeCandidates({ ir });
    candidates.sort(
      (left, right) =>
        left.request.calleeInstanceId - right.request.calleeInstanceId ||
        left.request.identity.localeCompare(right.request.identity) ||
        left.callSiteKey.localeCompare(right.callSiteKey) ||
        left.callerInstanceId - right.callerInstanceId,
    );
    const candidatesByCallee = new Map<
      ProgramFunctionInstanceId,
      Map<string, CallShapeCandidate[]>
    >();
    candidates.forEach((candidate) => {
      const byShape =
        candidatesByCallee.get(candidate.request.calleeInstanceId) ?? new Map();
      const shapeKey = candidate.request.keyTokens.join("|");
      byShape.set(shapeKey, [...(byShape.get(shapeKey) ?? []), candidate]);
      candidatesByCallee.set(candidate.request.calleeInstanceId, byShape);
    });

    const selected = new Map<
      string,
      Map<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
    >();
    let uniqueShapes = 0;
    let rejectedByPlannerBudget = 0;
    candidatesByCallee.forEach((byShape) => {
      const ranked = Array.from(byShape.entries()).sort(
        ([leftKey, left], [rightKey, right]) =>
          right.length - left.length || leftKey.localeCompare(rightKey),
      );
      const admitted = ranked.slice(
        0,
        Math.min(
          ir.facts.codegenPlan.specializationPolicy
            .callShapeContextsPerFunction,
          ir.facts.codegenPlan.specializationReservations.call_shape
            .contextsPerFunction,
        ),
      );
      uniqueShapes += admitted.length;
      rejectedByPlannerBudget += ranked.length - admitted.length;
      admitted.forEach(([, shapeCandidates]) => {
        shapeCandidates.forEach((candidate) => {
          const byCaller = selected.get(candidate.callSiteKey) ?? new Map();
          byCaller.set(candidate.callerInstanceId, candidate.request);
          selected.set(candidate.callSiteKey, byCaller);
        });
      });
    });

    const changed =
      serializeCallShapeSpecializationRequests(
        ir.facts.callShapeSpecializationRequests,
      ) !== serializeCallShapeSpecializationRequests(selected);
    ctx.mutateProducedFacts((mutation) =>
      mutation.setFact("callShapeSpecializationRequests", selected),
    );
    return {
      changed,
      metrics: {
        candidate_calls: candidates.length,
        planned_calls: Array.from(selected.values()).reduce(
          (count, byCaller) => count + byCaller.size,
          0,
        ),
        selected_calls: Array.from(selected.values()).reduce(
          (count, byCaller) => count + byCaller.size,
          0,
        ),
        unique_shapes: uniqueShapes,
        rejected_by_planner_budget: rejectedByPlannerBudget,
        ...Object.fromEntries(
          Object.entries(skipped).map(([reason, count]) => [
            `skipped.${reason}`,
            count,
          ]),
        ),
      },
    };
  },
};
