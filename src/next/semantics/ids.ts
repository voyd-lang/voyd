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
export type TypeAliasDeclId = number;
export type ObjectDeclId = number;
export type ImplDeclId = number;

export type HirId = number;
export type HirItemId = HirId;
export type HirExprId = HirId;
export type HirStmtId = HirId;

export type TypeId = number;
export type TypeSchemeId = number;
export type TypeParamId = number;

export type EffectRowId = number;

/**
 * Every semantic artifact carries a `SourceSpan` for diagnostics. The parser
 * owns absolute offsets; later phases merely thread them through.
 */
export interface SourceSpan {
  file: string;
  start: number;
  end: number;
}

export type DiagnosticSeverity = "error" | "warning" | "note";

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  span: SourceSpan;
  related?: readonly Diagnostic[];
}
