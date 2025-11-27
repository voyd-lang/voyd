import type {
  HirGraph,
  HirBuilder,
  HirTypeExpr,
  HirObjectLiteralEntry,
  HirMatchArm,
  HirCondBranch,
  HirParameter,
  HirPattern,
  HirTypeParameter,
} from "../hir/index.js";
import type {
  BindingResult,
  BoundObject,
  BoundFunction,
  BoundTypeAlias,
  BoundTrait,
  BoundImpl,
} from "../binding/binding.js";
import type { NodeId, OverloadSetId, ScopeId, SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";

export interface LowerInputs {
  builder: HirBuilder;
  binding: BindingResult;
  moduleNodeId: NodeId;
}

export interface LowerScopeStack {
  current(): ScopeId;
  push(scope: ScopeId): void;
  pop(): void;
}

export interface LowerContext {
  builder: HirBuilder;
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  intrinsicSymbols: Map<string, SymbolId>;
  moduleNodeId: NodeId;
  overloadBySymbol: ReadonlyMap<SymbolId, OverloadSetId>;
}

export type IdentifierResolution =
  | { kind: "symbol"; symbol: SymbolId; name: string }
  | { kind: "overload-set"; name: string; set: OverloadSetId };

export type ModuleDeclaration =
  | { kind: "function"; order: number; fn: BoundFunction }
  | { kind: "type-alias"; order: number; alias: BoundTypeAlias }
  | { kind: "object"; order: number; object: BoundObject }
  | { kind: "trait"; order: number; trait: BoundTrait }
  | { kind: "impl"; order: number; impl: BoundImpl };

export interface LoweredTypeInfo {
  baseSymbol?: SymbolId;
  type: HirTypeExpr;
}

export interface LowerObjectLiteralOptions {
  literalKind?: "structural" | "nominal";
  target?: HirTypeExpr;
  targetSymbol?: SymbolId;
}
