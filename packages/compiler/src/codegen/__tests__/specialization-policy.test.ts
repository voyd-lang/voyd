import { describe, expect, it } from "vitest";
import type { FunctionMetadata } from "../context.js";
import type { HirFunction } from "../../semantics/hir/index.js";
import type { SpecializationPolicy } from "../../optimization-policy.js";
import {
  composeSpecializationDimensions,
  functionSpecializationIdentity,
  tryAdmitFunctionSpecialization,
} from "../specialization-policy.js";
import { createTestCodegenContext } from "./support/test-codegen-context.js";
import { getOrCreateReceiverSpecialization } from "../receiver-specialization.js";
import { createSpecializationReservations } from "../../optimize/codegen-plan.js";

const baseMeta = {
  moduleId: "src::main",
  instanceId: 7,
} as FunctionMetadata;

describe("codegen specialization identity", () => {
  it("keeps scalar variants distinct across receiver contexts", () => {
    const boxReceiver = composeSpecializationDimensions({
      meta: baseMeta,
      next: { receiver: [[10, 100]] },
    });
    const altReceiver = composeSpecializationDimensions({
      meta: baseMeta,
      next: { receiver: [[10, 200]] },
    });
    const boxScalar = composeSpecializationDimensions({
      meta: { ...baseMeta, specialization: boxReceiver },
      next: {
        scalarAggregate: { parameterIndexes: [1], result: false },
      },
    });
    const altScalar = composeSpecializationDimensions({
      meta: { ...baseMeta, specialization: altReceiver },
      next: {
        scalarAggregate: { parameterIndexes: [1], result: false },
      },
    });

    expect(
      functionSpecializationIdentity({
        meta: baseMeta,
        dimensions: boxScalar,
      }),
    ).not.toBe(
      functionSpecializationIdentity({
        meta: baseMeta,
        dimensions: altScalar,
      }),
    );
  });

  it("composes effect and future call-shape dimensions without losing ABI facts", () => {
    const receiver = composeSpecializationDimensions({
      meta: baseMeta,
      next: { receiver: [[10, 100]] },
    });
    const scalar = composeSpecializationDimensions({
      meta: { ...baseMeta, specialization: receiver },
      next: {
        scalarAggregate: { parameterIndexes: [1], result: true },
      },
    });
    const effect = composeSpecializationDimensions({
      meta: { ...baseMeta, specialization: scalar },
      next: { staticEffect: "handler:42" },
    });
    const callShape = composeSpecializationDimensions({
      meta: { ...baseMeta, specialization: effect },
      next: { callShape: ["v1", "provided", "omitted"] },
    });

    expect(callShape).toEqual({
      receiver: [[10, 100]],
      scalarAggregate: { parameterIndexes: [1], result: true },
      staticEffect: "handler:42",
      callShape: ["v1", "provided", "omitted"],
    });
  });
});

describe("codegen specialization admission", () => {
  it("applies the receiver fact cap after inherited facts are composed", () => {
    const { ctx, expressions } = createTestCodegenContext();
    expressions.set(1, {
      kind: "expr",
      exprKind: "literal",
      id: 1,
      literalKind: "i32",
      value: "0",
    } as never);
    const item = {
      kind: "function",
      symbol: 1,
      body: 1,
    } as HirFunction;
    (ctx.module.hir as unknown as { items: Map<number, HirFunction> }).items =
      new Map([[1, item]]);
    ctx.optimization = {
      exactParameterTypes: new Map([
        [baseMeta.instanceId, new Map([[10, 100]])],
      ]),
    } as never;
    const meta = {
      ...baseMeta,
      moduleId: "test",
      symbol: 1,
      wasmName: "target",
    } as FunctionMetadata;

    expect(
      getOrCreateReceiverSpecialization({
        ctx,
        meta,
        exactParameterTypes: new Map([
          [20, 200],
          [30, 300],
        ]),
      }),
    ).toBeUndefined();
  });

  it("enforces the combined per-function budget across specialization kinds", () => {
    const { ctx, item } = createAdmissionFixture({
      totalContextsPerFunction: 1,
    });
    const receiver = { receiver: [[10, 100]] } as const;
    const scalarAggregate = {
      scalarAggregate: { parameterIndexes: [1], result: false },
    } as const;

    expect(
      tryAdmitFunctionSpecialization({
        ctx,
        meta: baseMeta,
        item,
        kind: "receiver",
        dimensions: receiver,
        existingKindVariants: 0,
        maxKindVariants: 10,
      }),
    ).toBe(true);
    expect(
      tryAdmitFunctionSpecialization({
        ctx,
        meta: baseMeta,
        item,
        kind: "scalar_aggregate",
        dimensions: scalarAggregate,
        existingKindVariants: 0,
        maxKindVariants: 10,
      }),
    ).toBe(false);
  });

  it("reserves shared budgets deterministically across kind encounter order", () => {
    const run = (order: readonly ("receiver" | "scalar_aggregate")[]) => {
      const { ctx, item } = createAdmissionFixture({
        totalContextsPerFunction: 2,
        totalContextsPerProgram: 2,
        totalEstimatedBodyNodes: 2,
      });
      return new Set(
        order.filter((kind) =>
          tryAdmitFunctionSpecialization({
            ctx,
            meta: baseMeta,
            item,
            kind,
            dimensions:
              kind === "receiver"
                ? { receiver: [[10, 100]] }
                : {
                    scalarAggregate: {
                      parameterIndexes: [1],
                      result: false,
                    },
                  },
            existingKindVariants: 0,
            maxKindVariants: 10,
          }),
        ),
      );
    };

    expect(run(["receiver", "scalar_aggregate"])).toEqual(
      run(["scalar_aggregate", "receiver"]),
    );
  });

  it("enforces the program budget without rejecting reuse", () => {
    const { ctx, item } = createAdmissionFixture({
      totalContextsPerProgram: 1,
      totalEstimatedBodyNodes: 1,
    });
    const receiver = { receiver: [[10, 100]] } as const;
    const request = {
      ctx,
      meta: baseMeta,
      item,
      kind: "receiver" as const,
      dimensions: receiver,
      existingKindVariants: 0,
      maxKindVariants: 10,
    };

    expect(tryAdmitFunctionSpecialization(request)).toBe(true);
    expect(tryAdmitFunctionSpecialization(request)).toBe(true);
    expect(
      tryAdmitFunctionSpecialization({
        ...request,
        meta: {
          ...baseMeta,
          instanceId: 8 as FunctionMetadata["instanceId"],
        },
        dimensions: { receiver: [[10, 200]] },
      }),
    ).toBe(false);
  });

  it("enforces the aggregate estimated-body-node budget", () => {
    const { ctx, item } = createAdmissionFixture({
      totalContextsPerProgram: 10,
      totalEstimatedBodyNodes: 1,
    });
    const request = {
      ctx,
      item,
      kind: "receiver" as const,
      existingKindVariants: 0,
      maxKindVariants: 10,
    };

    expect(
      tryAdmitFunctionSpecialization({
        ...request,
        meta: baseMeta,
        dimensions: { receiver: [[10, 100]] },
      }),
    ).toBe(true);
    expect(
      tryAdmitFunctionSpecialization({
        ...request,
        meta: {
          ...baseMeta,
          instanceId: 8 as FunctionMetadata["instanceId"],
        },
        dimensions: { receiver: [[10, 200]] },
      }),
    ).toBe(false);
  });

  it("counts default-expression roots in the estimated body budget", () => {
    const { ctx, expressions } = createTestCodegenContext();
    expressions.set(1, {
      kind: "expr",
      exprKind: "literal",
      id: 1,
      literalKind: "i32",
      value: "0",
    } as never);
    expressions.set(2, {
      kind: "expr",
      exprKind: "literal",
      id: 2,
      literalKind: "i32",
      value: "1",
    } as never);
    ctx.specializationPolicy = {
      ...ctx.specializationPolicy,
      totalEstimatedBodyNodes: 1,
    };
    ctx.specializationReservations = createSpecializationReservations(
      ctx.specializationPolicy,
    );
    const item = {
      kind: "function",
      body: 1,
      parameters: [{ defaultValue: 2 }],
    } as unknown as HirFunction;

    expect(
      tryAdmitFunctionSpecialization({
        ctx,
        meta: baseMeta,
        item,
        kind: "call_shape",
        dimensions: { callShape: ["v1", "omitted"] },
        existingKindVariants: 0,
        maxKindVariants: 1,
      }),
    ).toBe(false);
  });

  it("enforces each specialization kind's local context budget first", () => {
    const { ctx, item } = createAdmissionFixture();

    expect(
      tryAdmitFunctionSpecialization({
        ctx,
        meta: baseMeta,
        item,
        kind: "static_effect",
        dimensions: { staticEffect: "handler:1" },
        existingKindVariants: 1,
        maxKindVariants: 1,
      }),
    ).toBe(false);
  });
});

const createAdmissionFixture = (
  overrides: Partial<SpecializationPolicy> = {},
) => {
  const { ctx, expressions } = createTestCodegenContext();
  ctx.specializationPolicy = {
    ...ctx.specializationPolicy,
    ...overrides,
  };
  ctx.specializationReservations = createSpecializationReservations(
    ctx.specializationPolicy,
  );
  expressions.set(1, {
    kind: "expr",
    exprKind: "literal",
    id: 1,
    literalKind: "i32",
    value: "0",
  } as never);
  return {
    ctx,
    item: { kind: "function", body: 1 } as HirFunction,
  };
};
