import type { HirExprId, SymbolId, TypeId } from "../semantics/ids.js";

export type ScalarObjectFieldRepresentationPlan = {
  name: string;
  typeId: TypeId;
};

export type ScalarObjectInitializerFieldPlan = {
  name: string;
  valueExpr: HirExprId;
};

export type ScalarObjectMethodReceiverInlinePlan = {
  callExpr: HirExprId;
  targetModuleId: string;
  targetSymbol: SymbolId;
};

export type ScalarObjectLocalRepresentationPlan = {
  kind: "scalar-object-local";
  moduleId: string;
  symbol: SymbolId;
  initializerExpr: HirExprId;
  typeId: TypeId;
  representation: "field-locals";
  fields: readonly ScalarObjectFieldRepresentationPlan[];
  initializerFields: readonly ScalarObjectInitializerFieldPlan[];
  operations: {
    fieldRead: "local";
    fieldWrite: "local";
    methodReceiverInline: readonly ScalarObjectMethodReceiverInlinePlan[];
    wholeValueMaterialization: { allowed: false };
  };
  verified: {
    directFieldInitializers: true;
    noUnsafeEscapes: true;
    noContinuationCapture: true;
    sourceOrderInitializers: true;
  };
};

export type ProgramCodegenOptimizationPlan = {
  representations: {
    scalarObjectLocals: ReadonlyMap<
      string,
      ReadonlyMap<SymbolId, ScalarObjectLocalRepresentationPlan>
    >;
  };
};

export const getScalarObjectLocalPlan = ({
  plan,
  moduleId,
  symbol,
}: {
  plan: ProgramCodegenOptimizationPlan | undefined;
  moduleId: string;
  symbol: SymbolId;
}): ScalarObjectLocalRepresentationPlan | undefined =>
  plan?.representations.scalarObjectLocals.get(moduleId)?.get(symbol);

export const getScalarObjectFieldPlan = ({
  plan,
  field,
}: {
  plan: ScalarObjectLocalRepresentationPlan;
  field: string;
}): ScalarObjectFieldRepresentationPlan | undefined =>
  plan.fields.find((candidate) => candidate.name === field);

export const allowsScalarObjectMethodReceiverInline = ({
  plan,
  callExpr,
  targetModuleId,
  targetSymbol,
}: {
  plan: ScalarObjectLocalRepresentationPlan;
  callExpr: HirExprId;
  targetModuleId: string;
  targetSymbol: SymbolId;
}): boolean =>
  plan.operations.methodReceiverInline.some(
    (candidate) =>
      candidate.callExpr === callExpr &&
      candidate.targetModuleId === targetModuleId &&
      candidate.targetSymbol === targetSymbol,
  );
