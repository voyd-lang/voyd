import binaryen from "binaryen";
import type { SymbolTable } from "../semantics/binder/index.js";
import type {
  HirGraph,
  HirExpression,
  HirFunction,
  HirPattern,
  HirBlockExpr,
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

export interface CodegenOptions {
  optimize?: boolean;
  validate?: boolean;
}

export interface CodegenResult {
  module: binaryen.Module;
}

export interface FunctionMetadata {
  symbol: SymbolId;
  wasmName: string;
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
  paramTypeIds: readonly TypeId[];
  resultTypeId: TypeId;
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
  runtimeType: binaryen.Type;
  interfaceType: binaryen.Type;
  fields: StructuralFieldInfo[];
  fieldMap: Map<string, StructuralFieldInfo>;
  ancestorsGlobal: string;
  fieldTableGlobal: string;
  methodTableGlobal: string;
  typeLabel: string;
}

export interface CodegenContext {
  mod: binaryen.Module;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  options: Required<CodegenOptions>;
  functions: Map<SymbolId, FunctionMetadata>;
  itemsToSymbols: Map<HirItemId, SymbolId>;
  structTypes: Map<TypeId, StructuralTypeInfo>;
  rtt: ReturnType<typeof createRttContext>;
}

export interface LocalBinding {
  index: number;
  type: binaryen.Type;
}

export interface FunctionContext {
  bindings: Map<SymbolId, LocalBinding>;
  locals: binaryen.Type[];
  nextLocalIndex: number;
  returnTypeId: TypeId;
}

export interface CompiledExpression {
  expr: binaryen.ExpressionRef;
  usedReturnCall: boolean;
}

export interface CompileCallOptions {
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
}

export type ExpressionCompiler = (
  exprId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  tailPosition?: boolean,
  expectedResultTypeId?: TypeId
) => CompiledExpression;

export type {
  SemanticsPipelineResult,
  TypingResult,
  HirGraph,
  HirFunction,
  HirExpression,
  HirPattern,
  HirBlockExpr,
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
