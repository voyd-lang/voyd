import type binaryen from "binaryen";
import type {
  HirCallExpr,
  HirExprId,
  FunctionMetadata,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { CallArgumentPlanEntry } from "../../../semantics/typing/types.js";

export type CallParam = {
  typeId: TypeId;
  label?: string;
  optional?: boolean;
  defaulted?: boolean;
  bindingKind?: string;
  name?: string;
  synthetic?: "stable-callsite-id";
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
  writebacks: binaryen.ExpressionRef[];
  consumedArgCount: number;
  meta?: FunctionMetadata;
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
