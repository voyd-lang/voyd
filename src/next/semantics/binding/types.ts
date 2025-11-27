import type { Form, Syntax } from "../../parser/index.js";
import type { SymbolRecord, SymbolTable } from "../binder/index.js";
import type {
  Diagnostic,
  NodeId,
  OverloadSetId,
  ScopeId,
  SymbolId,
} from "../ids.js";
import type { HirVisibility } from "../hir/index.js";
import {
  DeclTable,
  type FunctionDecl,
  type ObjectDecl,
  type ParameterDecl,
  type TypeAliasDecl,
  type ImplDecl,
} from "../decls.js";

export interface BindingInputs {
  moduleForm: Form;
  symbolTable: SymbolTable;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  functions: readonly BoundFunction[];
  typeAliases: readonly BoundTypeAlias[];
  objects: readonly BoundObject[];
  impls: readonly BoundImpl[];
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
}

export type BoundFunction = FunctionDecl;
export type BoundTypeAlias = TypeAliasDecl;
export type BoundParameter = ParameterDecl;
export type BoundObject = ObjectDecl;
export type BoundImpl = ImplDecl;

export interface BoundOverloadSet {
  id: OverloadSetId;
  name: string;
  scope: ScopeId;
  functions: readonly BoundFunction[];
}

export interface OverloadBucket {
  scope: ScopeId;
  name: string;
  functions: BoundFunction[];
  signatureIndex: Map<string, BoundFunction>;
  nonFunctionConflictReported: boolean;
}

export interface BindingContext {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
  overloadBuckets: Map<string, OverloadBucket>;
  syntaxByNode: Map<NodeId, Syntax>;
  nextModuleIndex: number;
}
