import binaryen from "binaryen";
import type { SymbolTable } from "../semantics/binder/index.js";
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
} from "../semantics/hir/index.js";
import type {
  HirExprId,
  HirItemId,
  HirStmtId,
  SymbolId,
  TypeId,
  EffectRowId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypingResult } from "../semantics/typing/typing.js";
import type { createRttContext } from "./rtt/index.js";
import type { BindingResult } from "../semantics/binding/binding.js";
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
import type { EffectsLoweringInfo } from "../middle/effects/analysis.js";

export interface CodegenOptions {
  optimize?: boolean;
  validate?: boolean;
  emitEffectHelpers?: boolean;
  continuationBackend?: ContinuationBackendOptions;
}

export interface CodegenResult {
  module: binaryen.Module;
  effectTable?: EffectTableSidecar;
}

export interface FunctionMetadata {
  moduleId: string;
  symbol: SymbolId;
  wasmName: string;
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
  paramTypeIds: readonly TypeId[];
  resultTypeId: TypeId;
  typeArgs: readonly TypeId[];
  instanceKey: string;
  effectful: boolean;
  effectRow?: EffectRowId;
}

export interface StructuralFieldInfo {
  name: string;
  typeId: TypeId;
  wasmType: binaryen.Type;
  runtimeIndex: number;
  hash: number;
  getterType?: binaryen.Type;
  setterType?: binaryen.Type;
}

export interface StructuralTypeInfo {
  typeId: TypeId;
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
  effectIdOffset: number;
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  effectsInfo: EffectsLoweringInfo;
  options: Required<CodegenOptions>;
  functions: Map<string, FunctionMetadata[]>;
  functionInstances: Map<string, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, { moduleId: string; symbol: SymbolId }>;
  structTypes: Map<string, StructuralTypeInfo>;
  fixedArrayTypes: Map<TypeId, FixedArrayWasmType>;
  closureTypes: Map<string, ClosureTypeInfo>;
  functionRefTypes: Map<string, binaryen.Type>;
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
  returnTypeId: TypeId;
}

export interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  tempLocals: Map<number, LocalBindingLocal>;
  locals: binaryen.Type[];
  nextLocalIndex: number;
  returnTypeId: TypeId;
  currentHandler?: { index: number; type: binaryen.Type };
  instanceKey?: string;
  typeInstanceKey?: string;
  effectful: boolean;
  handlerStack?: HandlerScope[];
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
  typeInstanceKey?: string;
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
  SemanticsPipelineResult,
  TypingResult,
  HirGraph,
  HirFunction,
  HirExpression,
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
  SymbolTable,
  HirExprId,
  HirItemId,
  HirStmtId,
  SymbolId,
  TypeId,
  HirLambdaExpr,
  EffectRowId,
  OutcomeValueBox,
};
