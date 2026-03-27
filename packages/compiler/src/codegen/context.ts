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
  HirMethodCallExpr,
  HirTypeExpr,
  HirLambdaExpr,
  HirCondExpr,
  HirEffectHandlerExpr,
  HirBindingKind,
} from "../semantics/hir/index.js";
import type {
  HirExprId,
  HirItemId,
  HirStmtId,
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
  TypeParamId,
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
import type { ProgramOptimizationFacts } from "../optimize/ir.js";

export interface CodegenOptions {
  optimize?: boolean;
  optimizationProfile?: "aggressive" | "standard";
  validate?: boolean;
  runtimeDiagnostics?: boolean;
  emitEffectHelpers?: boolean;
  effectsHostBoundary?: "msgpack" | "off";
  linearMemoryExport?: "always" | "auto" | "off";
  effectsMemoryExport?: "auto" | "always" | "off";
  continuationBackend?: ContinuationBackendOptions;
  testMode?: boolean;
  testScope?: "all" | "entry";
}

export interface CodegenResult {
  module: binaryen.Module;
  effectTable?: EffectTableSidecar;
  diagnostics: Diagnostic[];
  continuationBackendKind: "gc-trampoline" | "stack-switch";
}

export interface FunctionMetadata {
  moduleId: string;
  symbol: SymbolId;
  wasmName: string;
  paramTypes: readonly binaryen.Type[];
  paramAbiTypes: readonly (readonly binaryen.Type[])[];
  userParamOffset: number;
  firstUserParamIndex: number;
  resultType: binaryen.Type;
  resultAbiTypes: readonly binaryen.Type[];
  paramTypeIds: readonly TypeId[];
  parameters: readonly {
    typeId: TypeId;
    label?: string;
    optional?: boolean;
    name?: string;
    bindingKind?: HirBindingKind;
  }[];
  paramAbiKinds: readonly OptimizedValueAbiKind[];
  resultTypeId: TypeId;
  resultAbiKind: OptimizedValueAbiKind;
  outParamType?: binaryen.Type;
  typeArgs: readonly TypeId[];
  instanceId: ProgramFunctionInstanceId;
  effectful: boolean;
  effectRow?: EffectRowId;
}

export interface ModuleLetGetterMetadata {
  moduleId: string;
  symbol: SymbolId;
  wasmName: string;
  typeId: TypeId;
  wasmType: binaryen.Type;
}

export interface StructuralFieldInfo {
  name: string;
  typeId: TypeId;
  wasmType: binaryen.Type;
  inlineWasmTypes: readonly binaryen.Type[];
  inlineStart: number;
  inlineArity: number;
  heapWasmType: binaryen.Type;
  runtimeIndex: number;
  optional?: boolean;
  hash: number;
  getterType?: binaryen.Type;
  setterType?: binaryen.Type;
}

export interface StructuralTypeInfo {
  typeId: TypeId;
  layoutKind: "heap-object" | "value-object";
  runtimeTypeId: number;
  structuralId: TypeId;
  nominalId?: TypeId;
  nominalAncestors: readonly TypeId[];
  runtimeType: binaryen.Type;
  interfaceType: binaryen.Type;
  fields: StructuralFieldInfo[];
  fieldMap: Map<string, StructuralFieldInfo>;
  ancestorsGlobal?: string;
  fieldTableGlobal?: string;
  methodTableGlobal?: string;
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
  kind: "plain-array" | "inline-aggregate";
  type: binaryen.Type;
  heapType: HeapTypeRef;
  laneTypes?: readonly binaryen.Type[];
  laneArrayTypes?: readonly binaryen.Type[];
}

export interface ClosureTypeInfo {
  key: string;
  typeId: TypeId;
  interfaceType: binaryen.Type;
  fnRefType: binaryen.Type;
  paramTypes: readonly binaryen.Type[];
  paramAbiTypes: readonly (readonly binaryen.Type[])[];
  userParamOffset: number;
  resultType: binaryen.Type;
  resultAbiTypes: readonly binaryen.Type[];
}

export interface ActiveRecursiveHeapTypeGroup {
  structuralIds: ReadonlySet<TypeId>;
  fixedArrayTempRefsByElementStructuralId: ReadonlyMap<TypeId, binaryen.Type>;
}

export interface CodegenContext {
  mod: binaryen.Module;
  moduleId: string;
  moduleLabel: string;
  program: ProgramCodegenView;
  module: ModuleCodegenView;
  moduleContexts: ReadonlyMap<string, CodegenContext>;
  diagnostics: DiagnosticEmitter;
  options: Required<CodegenOptions>;
  programHelpers: ProgramHelperRegistry;
  functions: Map<string, Map<number, FunctionMetadata[]>>;
  functionInstances: Map<ProgramFunctionInstanceId, FunctionMetadata>;
  moduleLetGetters: Map<string, Map<SymbolId, ModuleLetGetterMetadata>>;
  itemsToSymbols: Map<HirItemId, { moduleId: string; symbol: SymbolId }>;
  structTypes: Map<string, StructuralTypeInfo>;
  structHeapTypes: Map<TypeId, binaryen.Type>;
  abiBoxTypes: Map<string, binaryen.Type>;
  structuralIdCache: Map<TypeId, TypeId | null>;
  resolvingStructuralIds: Set<TypeId>;
  resolvingStructuralHeapTypes: Set<TypeId>;
  activeRecursiveHeapTypeGroup?: ActiveRecursiveHeapTypeGroup;
  fixedArrayTypes: Map<number, FixedArrayWasmType>;
  closureTypes: Map<string, ClosureTypeInfo>;
  functionRefTypes: Map<string, binaryen.Type>;
  recursiveBinders: Map<TypeParamId, TypeId>;
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
        storageType: binaryen.Type;
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
  optimization?: ProgramOptimizationFacts;
}

export interface LocalBindingBase {
  type: binaryen.Type;
  storageType: binaryen.Type;
  typeId?: TypeId;
}

export type OptimizedValueAbiKind =
  | "direct"
  | "readonly_ref"
  | "mutable_ref"
  | "out_ref";

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

export interface LocalBindingStorageRef extends LocalBindingBase {
  kind: "storage-ref";
  index: number;
  mutable: boolean;
}

export type LocalBinding =
  | LocalBindingLocal
  | LocalBindingCapture
  | LocalBindingStorageRef;

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
  inliningStack?: readonly ProgramFunctionInstanceId[];
  nextControlFlowLabelId?: number;
  returnTypeId: TypeId;
  returnWasmType?: binaryen.Type;
  returnAbiKind?: OptimizedValueAbiKind;
  returnOutPointer?: LocalBindingStorageRef;
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
  HirMethodCallExpr,
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
