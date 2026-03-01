/**
 * Shared identifier aliases consumed by the binder, HIR lowering, and typing
 * phases. These are intentionally opaque so downstream code cannot depend on
 * their underlying representation.
 */
export type NodeId = number;
export type ScopeId = number;
export type SymbolId = number;
export type OverloadSetId = number;
export type FunctionDeclId = number;
export type ParameterDeclId = number;
export type ModuleLetDeclId = number;
export type TypeAliasDeclId = number;
export type ObjectDeclId = number;
export type TraitDeclId = number;
export type ImplDeclId = number;
export type EffectDeclId = number;

export type HirId = number;
export type HirItemId = HirId;
export type HirExprId = HirId;
export type HirStmtId = HirId;

export type TypeId = number;
export type TypeSchemeId = number;
export type TypeParamId = number;

export type EffectRowId = number;

export type ProgramSymbolId = number & { readonly __brand: "ProgramSymbolId" };
// Function symbols are a subset of program symbols; use the canonical program-wide id.
export type ProgramFunctionId = ProgramSymbolId;
export type ProgramFunctionInstanceId = number & {
  readonly __brand: "ProgramFunctionInstanceId";
};

export type {
  SourceSpan,
  DiagnosticSeverity,
  Diagnostic,
  DiagnosticPhase,
} from "../diagnostics/index.js";
