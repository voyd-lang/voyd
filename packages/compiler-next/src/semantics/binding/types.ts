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
  type TraitDecl,
  type ImplDecl,
} from "../decls.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import type { ModuleExportTable } from "../modules.js";
import type { SourceSpan } from "../ids.js";

export type StaticMethodTable = Map<
  SymbolId,
  Map<string, Set<SymbolId>>
>;

export type ModuleMemberTable = Map<
  SymbolId,
  Map<string, Set<SymbolId>>
>;

export interface BindingInputs {
  moduleForm: Form;
  symbolTable: SymbolTable;
  module?: ModuleNode;
  graph?: ModuleGraph;
  moduleExports?: Map<string, ModuleExportTable>;
  dependencies?: Map<string, BindingResult>;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  functions: readonly BoundFunction[];
  typeAliases: readonly BoundTypeAlias[];
  objects: readonly BoundObject[];
  traits: readonly BoundTrait[];
  impls: readonly BoundImpl[];
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
  uses: readonly BoundUse[];
  imports: readonly BoundImport[];
  staticMethods: StaticMethodTable;
  moduleMembers: ModuleMemberTable;
  dependencies: Map<string, BindingResult>;
  importedOverloadOptions: Map<OverloadSetId, readonly SymbolId[]>;
}

export type BoundFunction = FunctionDecl;
export type BoundTypeAlias = TypeAliasDecl;
export type BoundParameter = ParameterDecl;
export type BoundObject = ObjectDecl;
export type BoundTrait = TraitDecl;
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
  module: ModuleNode;
  graph: ModuleGraph;
  modulePath: ModulePath;
  moduleExports: Map<string, ModuleExportTable>;
  dependenciesBySpan: Map<string, ModuleDependency[]>;
  dependencies: Map<string, BindingResult>;
  uses: BoundUse[];
  imports: BoundImport[];
  staticMethods: StaticMethodTable;
  moduleMembers: ModuleMemberTable;
  pendingStaticMethods: PendingStaticMethod[];
  importedOverloadOptions: Map<OverloadSetId, readonly SymbolId[]>;
}

export interface BoundUse {
  form: Form;
  visibility: HirVisibility;
  entries: readonly BoundUseEntry[];
  order: number;
}

export interface BoundUseEntry {
  path: readonly string[];
  moduleId?: string;
  span: SourceSpan;
  importKind: "all" | "self" | "name";
  targetName?: string;
  alias?: string;
  imports: readonly BoundImport[];
}

export interface BoundImport {
  name: string;
  local: SymbolId;
  target?: ImportedTarget;
  visibility: HirVisibility;
  span?: SourceSpan;
}

export interface ImportedTarget {
  moduleId: string;
  symbol: SymbolId;
}

export interface PendingStaticMethod {
  targetExpr: Expr;
  scope: ScopeId;
  methodSymbol: SymbolId;
}
