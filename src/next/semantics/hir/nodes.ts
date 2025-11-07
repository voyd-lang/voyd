import type {
  EffectRowId,
  HirExprId,
  HirId,
  HirStmtId,
  NodeId,
  SourceSpan,
  SymbolId,
  TypeId,
} from "../ids.js";

export interface HirNodeBase {
  id: HirId;
  ast: NodeId;
  span: SourceSpan;
}

export interface HirModule extends HirNodeBase {
  kind: "module";
  path: string;
  scope: SymbolId;
  body: readonly HirStmtId[];
  exports: readonly SymbolId[];
}

export interface HirFunction extends HirNodeBase {
  kind: "function";
  symbol: SymbolId;
  parameters: readonly HirParameter[];
  body: HirExprId;
  effectRow?: EffectRowId;
}

export interface HirParameter {
  symbol: SymbolId;
  pattern: HirPattern;
  span: SourceSpan;
}

export type HirPattern = HirIdentifierPattern | HirDestructurePattern;

export interface HirIdentifierPattern {
  kind: "identifier";
  symbol: SymbolId;
}

export interface HirDestructurePattern {
  kind: "destructure";
  fields: readonly { name: string; pattern: HirPattern }[];
  spread?: HirPattern;
}

export type HirStatement = HirLetStatement | HirExprStatement | HirReturnStatement;

export interface HirLetStatement extends HirNodeBase {
  kind: "let";
  mutable: boolean;
  pattern: HirPattern;
  initializer: HirExprId;
}

export interface HirExprStatement extends HirNodeBase {
  kind: "expr-stmt";
  expr: HirExprId;
}

export interface HirReturnStatement extends HirNodeBase {
  kind: "return";
  value?: HirExprId;
}

export type HirExpression =
  | HirLiteralExpr
  | HirIdentifierExpr
  | HirCallExpr
  | HirBlockExpr
  | HirIfExpr
  | HirLoopExpr
  | HirMatchExpr
  | HirObjectLiteralExpr
  | HirFieldAccessExpr
  | HirAssignExpr;

export interface HirExpressionBase extends HirNodeBase {
  kind: "expr";
  exprKind: HirExprKind;
  typeHint?: TypeId;
}

export type HirExprKind =
  | "literal"
  | "identifier"
  | "call"
  | "block"
  | "if"
  | "loop"
  | "match"
  | "object-literal"
  | "field-access"
  | "assign";

export interface HirLiteralExpr extends HirExpressionBase {
  exprKind: "literal";
  literalKind: "number" | "string" | "boolean" | "null";
  value: string;
}

export interface HirIdentifierExpr extends HirExpressionBase {
  exprKind: "identifier";
  symbol: SymbolId;
}

export interface HirCallExpr extends HirExpressionBase {
  exprKind: "call";
  callee: HirExprId;
  args: readonly HirExprId[];
}

export interface HirBlockExpr extends HirExpressionBase {
  exprKind: "block";
  statements: readonly HirStmtId[];
  value?: HirExprId;
}

export interface HirIfExpr extends HirExpressionBase {
  exprKind: "if";
  condition: HirExprId;
  thenBranch: HirExprId;
  elseBranch?: HirExprId;
}

export interface HirLoopExpr extends HirExpressionBase {
  exprKind: "loop";
  body: HirExprId;
}

export interface HirMatchExpr extends HirExpressionBase {
  exprKind: "match";
  discriminant: HirExprId;
  arms: readonly HirMatchArm[];
}

export interface HirMatchArm {
  pattern: HirPattern;
  guard?: HirExprId;
  value: HirExprId;
}

export interface HirObjectLiteralExpr extends HirExpressionBase {
  exprKind: "object-literal";
  fields: readonly { name: string; value: HirExprId }[];
}

export interface HirFieldAccessExpr extends HirExpressionBase {
  exprKind: "field-access";
  target: HirExprId;
  field: string;
}

export interface HirAssignExpr extends HirExpressionBase {
  exprKind: "assign";
  target: HirExprId;
  value: HirExprId;
}

export type HirNode =
  | HirModule
  | HirFunction
  | HirStatement
  | HirExpression;
