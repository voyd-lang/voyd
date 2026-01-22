import type {
  EffectRowId,
  FunctionDeclId,
  HirExprId,
  HirId,
  HirItemId,
  HirStmtId,
  NodeId,
  OverloadSetId,
  SourceSpan,
  SymbolId,
  TypeId,
  ParameterDeclId,
  TypeAliasDeclId,
} from "../ids.js";
import type { IntrinsicAttribute } from "../../parser/attributes.js";

export type HirVisibilityLevel = "object" | "module" | "package" | "public";

export interface HirVisibility {
  level: HirVisibilityLevel;
  api?: boolean;
}

export type HirMemberModifier = "api" | "pri";

export const moduleVisibility = (): HirVisibility => ({ level: "module" });
export const packageVisibility = (): HirVisibility => ({ level: "package" });
export const publicVisibility = (): HirVisibility => ({ level: "public" });
export const objectVisibility = (): HirVisibility => ({ level: "object" });
export const withApi = (visibility: HirVisibility): HirVisibility => ({
  ...visibility,
  api: true,
});

export const visibilityRank = (visibility: HirVisibilityLevel): number => {
  switch (visibility) {
    case "object":
      return 0;
    case "module":
      return 1;
    case "package":
      return 2;
    case "public":
      return 3;
  }
};

export const maxVisibility = (
  a: HirVisibility,
  b: HirVisibility
): HirVisibility =>
  visibilityRank(a.level) >= visibilityRank(b.level)
    ? { ...a, api: a.api || b.api }
    : { ...b, api: a.api || b.api };

export const inheritMemberVisibility = ({
  ownerVisibility,
  modifier,
}: {
  ownerVisibility: HirVisibility;
  modifier?: HirMemberModifier;
}): HirVisibility => {
  const baseLevel =
    ownerVisibility.level === "public" ? "package" : ownerVisibility.level;
  if (modifier === "pri") {
    return objectVisibility();
  }
  if (modifier === "api") {
    return withApi({ level: baseLevel });
  }
  return { level: baseLevel };
};

export const isPublicVisibility = (visibility: HirVisibility): boolean =>
  visibility.level === "public";

export const isPackageVisible = (visibility: HirVisibility): boolean =>
  visibility.level === "package" || visibility.level === "public";

export interface HirNodeBase {
  id: HirId;
  ast: NodeId;
  span: SourceSpan;
}

export interface HirTypeExprBase {
  ast: NodeId;
  span: SourceSpan;
  typeId?: TypeId;
}

export type HirTypeExpr =
  | HirNamedTypeExpr
  | HirObjectTypeExpr
  | HirTupleTypeExpr
  | HirUnionTypeExpr
  | HirIntersectionTypeExpr
  | HirFunctionTypeExpr
  | HirSelfTypeExpr;

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

export interface HirUnionTypeExpr extends HirTypeExprBase {
  typeKind: "union";
  members: readonly HirTypeExpr[];
}

export interface HirIntersectionTypeExpr extends HirTypeExprBase {
  typeKind: "intersection";
  members: readonly HirTypeExpr[];
}

export interface HirFunctionTypeParameter {
  type: HirTypeExpr;
  optional?: boolean;
}

export interface HirFunctionTypeExpr extends HirTypeExprBase {
  typeKind: "function";
  typeParameters?: readonly HirTypeParameter[];
  parameters: readonly HirFunctionTypeParameter[];
  returnType: HirTypeExpr;
  effectType?: HirTypeExpr;
}

export interface HirSelfTypeExpr extends HirTypeExprBase {
  typeKind: "self";
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
  | HirModuleDecl
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

export interface HirModuleDecl extends HirItemBase {
  kind: "module-decl";
  symbol: SymbolId;
  path: string;
  scope: SymbolId;
  items: readonly HirItemId[];
  exports: readonly HirExportEntry[];
}

export interface HirFunction extends HirItemBase {
  kind: "function";
  decl?: FunctionDeclId;
  symbol: SymbolId;
  memberVisibility?: HirVisibility;
  typeParameters?: readonly HirTypeParameter[];
  parameters: readonly HirParameter[];
  returnType?: HirTypeExpr;
  effectType?: HirTypeExpr;
  body: HirExprId;
  effectRow?: EffectRowId;
  intrinsic?: IntrinsicAttribute;
}

export interface HirParameter {
  symbol: SymbolId;
  pattern: HirPattern;
  span: SourceSpan;
  mutable: boolean;
  decl?: ParameterDeclId;
  label?: string;
  optional?: boolean;
  type?: HirTypeExpr;
  defaultValue?: HirExprId;
}

export type HirBindingKind = "value" | "mutable-ref" | "immutable-ref";

export interface HirPatternBase {
  bindingKind?: HirBindingKind;
  typeId?: TypeId;
  span?: SourceSpan;
  typeAnnotation?: HirTypeExpr;
}

export type HirPattern =
  | HirIdentifierPattern
  | HirDestructurePattern
  | HirTuplePattern
  | HirWildcardPattern
  | HirTypePattern;

export interface HirIdentifierPattern extends HirPatternBase {
  kind: "identifier";
  symbol: SymbolId;
}

export interface HirDestructurePattern extends HirPatternBase {
  kind: "destructure";
  fields: readonly { name: string; pattern: HirPattern }[];
  spread?: HirPattern;
}

export interface HirTuplePattern extends HirPatternBase {
  kind: "tuple";
  elements: readonly HirPattern[];
}

export interface HirWildcardPattern extends HirPatternBase {
  kind: "wildcard";
}

export interface HirTypePattern extends HirPatternBase {
  kind: "type";
  type: HirTypeExpr;
  binding?: HirPattern;
}

export interface HirTypeAlias extends HirItemBase {
  kind: "type-alias";
  decl?: TypeAliasDeclId;
  symbol: SymbolId;
  typeParameters?: readonly HirTypeParameter[];
  target: HirTypeExpr;
}

export interface HirObjectField {
  name: string;
  symbol: SymbolId;
  visibility: HirVisibility;
  type?: HirTypeExpr;
  optional?: boolean;
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
  bindingKind?: HirBindingKind;
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
  typeParameters?: readonly HirTypeParameter[];
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
  | HirOverloadSetExpr
  | HirCallExpr
  | HirMethodCallExpr
  | HirBlockExpr
  | HirTupleExpr
  | HirLoopExpr
  | HirWhileExpr
  | HirCondExpr
  | HirIfExpr
  | HirMatchExpr
  | HirLambdaExpr
  | HirEffectHandlerExpr
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
  | "overload-set"
  | "call"
  | "method-call"
  | "block"
  | "tuple"
  | "loop"
  | "while"
  | "cond"
  | "if"
  | "match"
  | "lambda"
  | "effect-handler"
  | "object-literal"
  | "field-access"
  | "assign"
  | "break"
  | "continue";

export interface HirLiteralExpr extends HirExpressionBase {
  exprKind: "literal";
  literalKind:
    | "i32"
    | "i64"
    | "f32"
    | "f64"
    | "string"
    | "boolean"
    | "void"
    | "symbol";
  value: string;
}

export interface HirIdentifierExpr extends HirExpressionBase {
  exprKind: "identifier";
  symbol: SymbolId;
}

export interface HirOverloadSetExpr extends HirExpressionBase {
  exprKind: "overload-set";
  name: string;
  set: OverloadSetId;
}

export interface HirCallExpr extends HirExpressionBase {
  exprKind: "call";
  callee: HirExprId;
  args: readonly { label?: string; expr: HirExprId }[];
  typeArguments?: readonly HirTypeExpr[];
}

export interface HirMethodCallExpr extends HirExpressionBase {
  exprKind: "method-call";
  target: HirExprId;
  method: string;
  args: readonly { label?: string; expr: HirExprId }[];
  typeArguments?: readonly HirTypeExpr[];
}

export interface HirBlockExpr extends HirExpressionBase {
  exprKind: "block";
  statements: readonly HirStmtId[];
  value?: HirExprId;
}

export interface HirTupleExpr extends HirExpressionBase {
  exprKind: "tuple";
  elements: readonly HirExprId[];
}
export interface HirLoopExpr extends HirExpressionBase {
  exprKind: "loop";
  body: HirExprId;
}

export interface HirWhileExpr extends HirExpressionBase {
  exprKind: "while";
  condition: HirExprId;
  body: HirExprId;
}

export interface HirIfExpr extends HirExpressionBase {
  exprKind: "if";
  branches: readonly HirCondBranch[];
  defaultBranch?: HirExprId;
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

export interface HirLambdaExpr extends HirExpressionBase {
  exprKind: "lambda";
  typeParameters?: readonly HirTypeParameter[];
  parameters: readonly HirParameter[];
  returnType?: HirTypeExpr;
  effectType?: HirTypeExpr;
  body: HirExprId;
  captures: readonly HirCapture[];
  owner?: HirCallableOwner;
}

export interface HirEffectHandlerClause {
  operation: SymbolId;
  effect?: SymbolId;
  resumable: "ctl" | "fn";
  parameters: readonly HirMethodParameter[];
  body: HirExprId;
  tailResumption?: {
    enforcement: "static" | "runtime";
    calls: number;
    minCalls?: number;
    escapes: boolean;
  };
}

export interface HirEffectHandlerExpr extends HirExpressionBase {
  exprKind: "effect-handler";
  body: HirExprId;
  handlers: readonly HirEffectHandlerClause[];
  finallyBranch?: HirExprId;
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
  target?: HirExprId;
  pattern?: HirPattern;
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

export interface HirCapture {
  symbol: SymbolId;
  span: SourceSpan;
  mutable: boolean;
}

export type HirCallableOwner =
  | { kind: "function"; item: HirItemId; symbol: SymbolId }
  | { kind: "lambda"; expr: HirExprId };

export type HirNode = HirModule | HirItem | HirStatement | HirExpression;
