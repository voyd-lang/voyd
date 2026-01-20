import binaryen from "binaryen";
import type {
  HirGraph,
  HirExpression,
  HirFunction,
  HirPattern,
  HirBlockExpr,
  HirLetStatement,
  HirIfExpr,
  HirMatchExpr,
  HirWhileExpr,
  HirAssignExpr,
  HirObjectLiteralExpr,
  HirFieldAccessExpr,
  HirCallExpr,
  HirTypeExpr,
  HirLambdaExpr,
  HirCondExpr,
  HirEffectHandlerExpr,
} from "../semantics/hir/index.js";
import type {
  HirExprId,
  HirItemId,
  HirStmtId,
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
  EffectRowId,
} from "../semantics/ids.js";
import type { createRttContext } from "./rtt/index.js";
import type { HeapTypeRef } from "@voyd/lib/binaryen-gc/types.js";
import type { EffectRuntime } from "./effects/runtime-abi.js";
import type { OutcomeValueBox } from "./effects/outcome-values.js";
import type { EffectTableSidecar } from "./effects/effect-table-types.js";
import type { EffectLoweringResult } from "./effects/effect-lowering.js";
import type { ResumeKind } from "./effects/runtime-abi.js";
import type { ContinuationBackendOptions } from "./effects/backend.js";
import type { EffectsBackend } from "./effects/codegen-backend.js";
import type { EffectsState } from "./effects/state.js";
import type { GroupContinuationCfg } from "./effects/continuation-cfg.js";
import type { ProgramCodegenView } from "../semantics/codegen-view/index.js";
import type { ModuleCodegenView } from "../semantics/codegen-view/index.js";
import type { Diagnostic, DiagnosticEmitter } from "../diagnostics/index.js";
import type { ProgramHelperRegistry } from "./program-helpers.js";

export interface CodegenOptions {
  optimize?: boolean;
  validate?: boolean;
  emitEffectHelpers?: boolean;
  continuationBackend?: ContinuationBackendOptions;
  testMode?: boolean;
}

export interface CodegenResult {
  module: binaryen.Module;
  effectTable?: EffectTableSidecar;
  diagnostics: Diagnostic[];
}

export interface FunctionMetadata {
  moduleId: string;
  symbol: SymbolId;
  wasmName: string;
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
  paramTypeIds: readonly TypeId[];
  parameters: readonly {
    typeId: TypeId;
    label?: string;
    optional?: boolean;
    name?: string;
  }[];
  resultTypeId: TypeId;
  typeArgs: readonly TypeId[];
  instanceId: ProgramFunctionInstanceId;
  effectful: boolean;
  effectRow?: EffectRowId;
}

export interface StructuralFieldInfo {
  name: string;
  typeId: TypeId;
  wasmType: binaryen.Type;
  runtimeIndex: number;
  optional?: boolean;
  hash: number;
  getterType?: binaryen.Type;
  setterType?: binaryen.Type;
}

export interface StructuralTypeInfo {
  typeId: TypeId;
  runtimeTypeId: number;
  structuralId: TypeId;
  nominalId?: TypeId;
  nominalAncestors: readonly TypeId[];
  runtimeType: binaryen.Type;
  interfaceType: binaryen.Type;
  fields: StructuralFieldInfo[];
  fieldMap: Map<string, StructuralFieldInfo>;
  ancestorsGlobal: string;
  fieldTableGlobal: string;
  methodTableGlobal: string;
  typeLabel: string;
}

export type RuntimeTypeIdRegistryEntry = {
  key: string;
  moduleId: string;
  typeId: TypeId;
};

export type RuntimeTypeIdState = {
  byKey: Map<string, number>;
  nextId: { value: number };
};

export interface FixedArrayWasmType {
  type: binaryen.Type;
  heapType: HeapTypeRef;
}

export interface ClosureTypeInfo {
  key: string;
  typeId: TypeId;
  interfaceType: binaryen.Type;
  fnRefType: binaryen.Type;
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
}

export interface CodegenContext {
  mod: binaryen.Module;
  moduleId: string;
  moduleLabel: string;
  program: ProgramCodegenView;
  module: ModuleCodegenView;
  diagnostics: DiagnosticEmitter;
  options: Required<CodegenOptions>;
  programHelpers: ProgramHelperRegistry;
  functions: Map<string, Map<number, FunctionMetadata[]>>;
  functionInstances: Map<ProgramFunctionInstanceId, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, { moduleId: string; symbol: SymbolId }>;
  structTypes: Map<string, StructuralTypeInfo>;
  fixedArrayTypes: Map<TypeId, FixedArrayWasmType>;
  closureTypes: Map<string, ClosureTypeInfo>;
  functionRefTypes: Map<string, binaryen.Type>;
  runtimeTypeRegistry: Map<TypeId, RuntimeTypeIdRegistryEntry>;
  runtimeTypeIds: RuntimeTypeIdState;
  lambdaEnvs: Map<
    string,
    {
      envType: binaryen.Type;
      captures: readonly {
        symbol: SymbolId;
        typeId: TypeId;
        wasmType: binaryen.Type;
        mutable: boolean;
        fieldIndex: number;
      }[];
      base: ClosureTypeInfo;
      typeId: TypeId;
    }
  >;
  lambdaFunctions: Map<string, string>;
  rtt: ReturnType<typeof createRttContext>;
  effectsRuntime: EffectRuntime;
  effectsBackend: EffectsBackend;
  effectsState: EffectsState;
  effectLowering: EffectLoweringResult;
  outcomeValueTypes: Map<string, OutcomeValueBox>;
}

export interface LocalBindingBase {
  type: binaryen.Type;
  typeId?: TypeId;
}

export interface LocalBindingLocal extends LocalBindingBase {
  kind: "local";
  index: number;
}

export interface LocalBindingCapture extends LocalBindingBase {
  kind: "capture";
  envIndex: number;
  envType: binaryen.Type;
  envSuperType: binaryen.Type;
  fieldIndex: number;
  typeId: TypeId;
  mutable: boolean;
}

export type LocalBinding = LocalBindingLocal | LocalBindingCapture;

export interface HandlerScope {
  prevHandler: LocalBindingLocal;
  label?: number;
}

export interface ContinuationBinding {
  continuationLocal: LocalBindingLocal;
  tailGuardLocal: LocalBindingLocal;
  resumeKind: ResumeKind;
  resumeTypeId: TypeId;
}

export interface LoopScope {
  breakLabel: string;
  continueLabel: string;
  label?: string;
}

export interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  tempLocals: Map<number, LocalBindingLocal>;
  locals: binaryen.Type[];
  nextLocalIndex: number;
  returnTypeId: TypeId;
  currentHandler?: { index: number; type: binaryen.Type };
  instanceId?: ProgramFunctionInstanceId;
  typeInstanceId?: ProgramFunctionInstanceId;
  effectful: boolean;
  handlerStack?: HandlerScope[];
  loopStack?: LoopScope[];
  continuations?: Map<SymbolId, ContinuationBinding>;
  continuation?: {
    cfg: GroupContinuationCfg;
    startedLocal: LocalBindingLocal;
    activeSiteLocal: LocalBindingLocal;
  };
}

export interface CompiledExpression {
  expr: binaryen.ExpressionRef;
  usedReturnCall: boolean;
}

export interface CompileCallOptions {
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
  typeInstanceId?: ProgramFunctionInstanceId;
}

export interface ExpressionCompilerParams {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
}

export type ExpressionCompiler = (
  params: ExpressionCompilerParams
) => CompiledExpression;

export type {
  HirGraph,
  HirFunction,
  HirExpression,
  HirPattern,
  HirBlockExpr,
  HirLetStatement,
  HirIfExpr,
  HirMatchExpr,
  HirWhileExpr,
  HirCondExpr,
  HirAssignExpr,
  HirObjectLiteralExpr,
  HirFieldAccessExpr,
  HirCallExpr,
  HirTypeExpr,
  HirEffectHandlerExpr,
  HirExprId,
  HirItemId,
  HirStmtId,
  SymbolId,
  TypeId,
  HirLambdaExpr,
  EffectRowId,
  OutcomeValueBox,
};
