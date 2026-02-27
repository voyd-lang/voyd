import type binaryen from "binaryen";
import type {
  HirCallExpr,
  HirExprId,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { CallArgumentPlanEntry } from "../../../semantics/typing/types.js";

export type CallParam = {
  typeId: TypeId;
  label?: string;
  optional?: boolean;
  name?: string;
};

export type CompileCallArgumentOptions = {
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  argIndexOffset?: number;
  allowTrailingArguments?: boolean;
  allCallArgExprIds?: readonly HirExprId[];
  typedPlan?: readonly CallArgumentPlanEntry[];
};

export type CompiledCallArgumentsForParams = {
  args: binaryen.ExpressionRef[];
  consumedArgCount: number;
};

export type PlannedCallArguments = {
  plan: CallArgumentPlanEntry[];
  expectedTypeByArgIndex: Map<number, TypeId>;
  consumedArgCount: number;
};

export type BuildCallArgumentFailureOptions = {
  call: HirCallExpr;
  params: readonly CallParam[];
  ctxModuleId: string;
  calleeName: string;
  argIndexOffset: number;
  argsSummary: string;
};
