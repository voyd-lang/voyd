import type {
  NodeId,
  ScopeId,
  SymbolId,
  TypeSchemeId,
} from "../ids.js";

export type ScopeKind =
  | "module"
  | "function"
  | "lambda"
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
  | "macro"
  | "effect"
  | "effect-op";

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
