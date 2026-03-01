import type { Expr, Form, Syntax } from "../../parser/index.js";
import type { SymbolTable } from "../binder/index.js";
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
  type ModuleLetDecl,
  type ObjectDecl,
  type ParameterDecl,
  type TypeAliasDecl,
  type TraitDecl,
  type ImplDecl,
  type EffectDecl,
} from "../decls.js";
import type {
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import type { UsePathSelectionKind } from "../../modules/use-path.js";
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
  includeTests?: boolean;
}

export interface BindingResult {
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
  decls: DeclTable;
  functions: readonly BoundFunction[];
  moduleLets: readonly BoundModuleLet[];
  typeAliases: readonly BoundTypeAlias[];
  objects: readonly BoundObject[];
  traits: readonly BoundTrait[];
  impls: readonly BoundImpl[];
  effects: readonly BoundEffect[];
  overloads: Map<OverloadSetId, BoundOverloadSet>;
  overloadBySymbol: Map<SymbolId, OverloadSetId>;
  diagnostics: Diagnostic[];
  uses: readonly BoundUse[];
  imports: readonly BoundImport[];
  staticMethods: StaticMethodTable;
  moduleMembers: ModuleMemberTable;
  dependencies: Map<string, BindingResult>;
  importedOverloadOptions: Map<OverloadSetId, readonly SymbolId[]>;
  modulePath: ModulePath;
  packageId: string;
  isPackageRoot: boolean;
}

export type BoundFunction = FunctionDecl;
export type BoundModuleLet = ModuleLetDecl;
export type BoundTypeAlias = TypeAliasDecl;
export type BoundParameter = ParameterDecl;
export type BoundObject = ObjectDecl;
export type BoundTrait = TraitDecl;
export type BoundImpl = ImplDecl;
export type BoundEffect = EffectDecl;

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
  packageId: string;
  isPackageRoot: boolean;
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, BindingResult>;
  uses: BoundUse[];
  imports: BoundImport[];
  staticMethods: StaticMethodTable;
  moduleMembers: ModuleMemberTable;
  memberDeclarationScopesByOwner: Map<SymbolId, ScopeId>;
  memberDeclarationScopesByOwnerAndTrait: Map<SymbolId, Map<SymbolId, ScopeId>>;
  pendingStaticMethods: PendingStaticMethod[];
  importedOverloadOptions: Map<OverloadSetId, readonly SymbolId[]>;
  includeTests: boolean;
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
  selectionKind: UsePathSelectionKind;
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
