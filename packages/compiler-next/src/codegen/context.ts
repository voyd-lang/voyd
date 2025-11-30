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
} from "../semantics/hir/index.js";
import type {
  HirExprId,
  HirItemId,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypingResult } from "../semantics/typing/typing.js";
import type { createRttContext } from "./rtt/index.js";
import type { BindingResult } from "../semantics/binding/binding.js";
import type { HeapTypeRef } from "@voyd/lib/binaryen-gc/types.js";

export interface CodegenOptions {
  optimize?: boolean;
  validate?: boolean;
}

export interface CodegenResult {
  module: binaryen.Module;
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
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  options: Required<CodegenOptions>;
  functions: Map<string, FunctionMetadata[]>;
  functionInstances: Map<string, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, { moduleId: string; symbol: SymbolId }>;
  structTypes: Map<string, StructuralTypeInfo>;
  fixedArrayTypes: Map<TypeId, FixedArrayWasmType>;
  closureTypes: Map<string, ClosureTypeInfo>;
  closureFunctionTypes: Map<string, binaryen.Type>;
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
}

export type LocalBinding =
  | {
      kind: "local";
      index: number;
      type: binaryen.Type;
      typeId?: TypeId;
    }
  | {
      kind: "capture";
      envIndex: number;
      envType: binaryen.Type;
      envSuperType: binaryen.Type;
      fieldIndex: number;
      type: binaryen.Type;
      typeId: TypeId;
      mutable: boolean;
    };

export interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  locals: binaryen.Type[];
  nextLocalIndex: number;
  returnTypeId: TypeId;
  instanceKey?: string;
}

export interface CompiledExpression {
  expr: binaryen.ExpressionRef;
  usedReturnCall: boolean;
}

export interface CompileCallOptions {
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
  instanceKey?: string;
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
};
