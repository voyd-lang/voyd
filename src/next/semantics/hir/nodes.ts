import type {
  EffectRowId,
  HirExprId,
  HirId,
  HirItemId,
  HirStmtId,
  NodeId,
  SourceSpan,
  SymbolId,
  TypeId,
} from "../ids.js";

export type HirVisibility = "public" | "module";

export interface HirNodeBase {
  id: HirId;
  ast: NodeId;
  span: SourceSpan;
}

export interface HirTypeExprBase {
  ast: NodeId;
  span: SourceSpan;
}

export type HirTypeExpr =
  | HirNamedTypeExpr
  | HirObjectTypeExpr
  | HirTupleTypeExpr;

export interface HirNamedTypeExpr extends HirTypeExprBase {
  typeKind: "named";
  path: readonly string[];
  symbol?: SymbolId;
  typeArguments?: readonly HirTypeExpr[];
}

export interface HirObjectTypeExpr extends HirTypeExprBase {
  typeKind: "object";
  fields: readonly HirRecordTypeField[];
  /**
   * Structural object types are open by default (extra fields are allowed).
   * Set `exact` to true when a type literal should forbid additional fields.
   */
  exact?: boolean;
}

export interface HirRecordTypeField {
  name: string;
  type: HirTypeExpr;
  span: SourceSpan;
}

export interface HirTupleTypeExpr extends HirTypeExprBase {
  typeKind: "tuple";
  elements: readonly HirTypeExpr[];
}

export interface HirTypeParameter {
  symbol: SymbolId;
  span: SourceSpan;
  constraint?: HirTypeExpr;
  defaultType?: HirTypeExpr;
}

export interface HirExportEntry {
  symbol: SymbolId;
  alias?: string;
  visibility: HirVisibility;
  item: HirItemId;
  span: SourceSpan;
}

export interface HirModule extends HirNodeBase {
  kind: "module";
  path: string;
  scope: SymbolId;
  items: readonly HirItemId[];
  exports: readonly HirExportEntry[];
}

export type HirItem =
  | HirUseItem
  | HirFunction
  | HirTypeAlias
  | HirObjectDecl
  | HirTraitDecl
  | HirImplDecl
  | HirEffectDecl;

export interface HirItemBase extends HirNodeBase {
  visibility: HirVisibility;
}

export interface HirUseItem extends HirItemBase {
  kind: "use";
  entries: readonly HirUseEntry[];
}

export interface HirUseEntry {
  path: readonly string[];
  alias?: string;
  importKind: "name" | "self" | "all";
  span: SourceSpan;
}

export interface HirFunction extends HirItemBase {
  kind: "function";
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  parameters: readonly HirParameter[];
  returnType?: HirTypeExpr;
  effectType?: HirTypeExpr;
  body: HirExprId;
  effectRow?: EffectRowId;
}

export interface HirParameter {
  symbol: SymbolId;
  pattern: HirPattern;
  span: SourceSpan;
  mutable: boolean;
  type?: HirTypeExpr;
  defaultValue?: HirExprId;
}

export type HirPattern =
  | HirIdentifierPattern
  | HirDestructurePattern
  | HirTuplePattern
  | HirWildcardPattern;

export interface HirIdentifierPattern {
  kind: "identifier";
  symbol: SymbolId;
}

export interface HirDestructurePattern {
  kind: "destructure";
  fields: readonly { name: string; pattern: HirPattern }[];
  spread?: HirPattern;
}

export interface HirTuplePattern {
  kind: "tuple";
  elements: readonly HirPattern[];
}

export interface HirWildcardPattern {
  kind: "wildcard";
}

export interface HirTypeAlias extends HirItemBase {
  kind: "type-alias";
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  target: HirTypeExpr;
}

export interface HirObjectField {
  name: string;
  symbol: SymbolId;
  type?: HirTypeExpr;
  span: SourceSpan;
}

export interface HirObjectDecl extends HirItemBase {
  kind: "object";
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  base?: HirTypeExpr;
  baseSymbol?: SymbolId;
  fields: readonly HirObjectField[];
  isFinal: boolean;
}

export interface HirTraitMethod {
  symbol: SymbolId;
  span: SourceSpan;
  typeParameters?: readonly HirTypeParameter[];
  parameters: readonly HirMethodParameter[];
  returnType?: HirTypeExpr;
  effectType?: HirTypeExpr;
  defaultBody?: HirExprId;
}

export interface HirMethodParameter {
  symbol: SymbolId;
  span: SourceSpan;
  type?: HirTypeExpr;
  mutable: boolean;
}

export interface HirTraitDecl extends HirItemBase {
  kind: "trait";
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  requirements?: readonly HirTypeExpr[];
  methods: readonly HirTraitMethod[];
}

export interface HirImplDecl extends HirItemBase {
  kind: "impl";
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  target: HirTypeExpr;
  trait?: HirTypeExpr;
  with?: readonly HirImplWithEntry[];
  members: readonly HirItemId[];
}

export type HirImplWithEntry = HirImplMemberImport | HirImplTraitImport;

export interface HirImplWithEntryBase {
  span: SourceSpan;
}

export interface HirImplMemberImport extends HirImplWithEntryBase {
  kind: "member-import";
  source: HirTypeExpr;
  members?: readonly HirMixinMemberRef[];
}

export interface HirMixinMemberRef {
  name: string;
  symbol?: SymbolId;
  span: SourceSpan;
}

export interface HirImplTraitImport extends HirImplWithEntryBase {
  kind: "trait-import";
  source: HirTypeExpr;
  trait: HirTypeExpr;
}

export interface HirEffectOperation {
  symbol: SymbolId;
  span: SourceSpan;
  resumable: "ctl" | "fn";
  parameters: readonly HirMethodParameter[];
  returnType?: HirTypeExpr;
}

export interface HirEffectDecl extends HirItemBase {
  kind: "effect";
  symbol: SymbolId;
  operations: readonly HirEffectOperation[];
}

export type HirStatement =
  | HirLetStatement
  | HirExprStatement
  | HirReturnStatement;

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
  | HirWhileExpr
  | HirCondExpr
  | HirMatchExpr
  | HirObjectLiteralExpr
  | HirFieldAccessExpr
  | HirAssignExpr
  | HirBreakExpr
  | HirContinueExpr;

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
  | "while"
  | "cond"
  | "match"
  | "object-literal"
  | "field-access"
  | "assign"
  | "break"
  | "continue";

export interface HirLiteralExpr extends HirExpressionBase {
  exprKind: "literal";
  literalKind: "number" | "string" | "boolean" | "null" | "void" | "symbol";
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
  typeArguments?: readonly HirTypeExpr[];
}

export interface HirBlockExpr extends HirExpressionBase {
  exprKind: "block";
  statements: readonly HirStmtId[];
  value?: HirExprId;
}

export interface HirWhileExpr extends HirExpressionBase {
  exprKind: "while";
  condition: HirExprId;
  body: HirExprId;
}

export interface HirCondExpr extends HirExpressionBase {
  exprKind: "cond";
  branches: readonly HirCondBranch[];
  defaultBranch?: HirExprId;
}

export interface HirCondBranch {
  condition: HirExprId;
  value: HirExprId;
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
  literalKind: "structural" | "nominal";
  target?: HirTypeExpr;
  targetSymbol?: SymbolId;
  entries: readonly HirObjectLiteralEntry[];
}

export type HirObjectLiteralEntry =
  | HirObjectLiteralField
  | HirObjectLiteralSpread;

export interface HirObjectLiteralField {
  kind: "field";
  name: string;
  value: HirExprId;
  span: SourceSpan;
}

export interface HirObjectLiteralSpread {
  kind: "spread";
  value: HirExprId;
  span: SourceSpan;
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

export interface HirBreakExpr extends HirExpressionBase {
  exprKind: "break";
  label?: string;
  value?: HirExprId;
}

export interface HirContinueExpr extends HirExpressionBase {
  exprKind: "continue";
  label?: string;
}

export type HirNode = HirModule | HirItem | HirStatement | HirExpression;
