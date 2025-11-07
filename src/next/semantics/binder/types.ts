import type {
  NodeId,
  ScopeId,
  SymbolId,
  TypeSchemeId,
} from "../ids.js";

export type ScopeKind =
  | "module"
  | "function"
  | "block"
  | "impl"
  | "trait"
  | "macro";

export type SymbolKind =
  | "value"
  | "parameter"
  | "type-parameter"
  | "type"
  | "trait"
  | "impl"
  | "module"
  | "macro";

export interface ScopeInfo {
  id: ScopeId;
  parent: ScopeId | null;
  kind: ScopeKind;
  owner: NodeId;
}

export interface SymbolRecord {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  declaredAt: NodeId;
  scope: ScopeId;
  scheme?: TypeSchemeId;
  metadata?: Record<string, unknown>;
}

export interface SymbolTableInit {
  /** Node that owns the root scope, typically the module AST node. */
  rootOwner: NodeId;
  /** Allows custom root kind for inline modules; defaults to `module`. */
  rootKind?: Extract<ScopeKind, "module" | "macro">;
}

export interface SymbolTableSnapshot {
  nextScope: ScopeId;
  nextSymbol: SymbolId;
  scopes: readonly ScopeInfo[];
  symbols: readonly SymbolRecord[];
  payload?: Record<string, unknown>;
}

export interface SymbolTable {
  readonly rootScope: ScopeId;
  createScope(info: Omit<ScopeInfo, "id">): ScopeId;
  enterScope(scope: ScopeId): void;
  exitScope(): void;
  declare(symbol: Omit<SymbolRecord, "id" | "scope">): SymbolId;
  resolve(name: string, fromScope: ScopeId): SymbolId | undefined;
  resolveAll(name: string, fromScope: ScopeId): readonly SymbolId[];
  getSymbol(id: SymbolId): Readonly<SymbolRecord>;
  getScope(id: ScopeId): Readonly<ScopeInfo>;
  symbolsInScope(scope: ScopeId): Iterable<SymbolId>;
  snapshot(payload?: Record<string, unknown>): SymbolTableSnapshot;
  restore(snapshot: SymbolTableSnapshot): void;
}
