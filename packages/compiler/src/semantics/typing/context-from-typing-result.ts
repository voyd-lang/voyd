import { DiagnosticEmitter } from "../../diagnostics/index.js";
import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type { HirGraph } from "../hir/index.js";
import type { OverloadSetId, SymbolId } from "../ids.js";
import type { ModuleExportTable } from "../modules.js";
import { cloneNestedMap } from "./call-resolution.js";
import type {
  DependencySemantics,
  TypeCheckBudgetState,
  TypingContext,
  TypingResult,
} from "./types.js";

export const createTypingContextFromTypingResult = ({
  symbolTable,
  hir,
  overloads,
  typeCheckBudget,
  decls,
  moduleId,
  packageId,
  moduleExports,
  dependencies,
  importsByLocal,
  importAliasesByModule,
  typing,
}: {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  typeCheckBudget: TypeCheckBudgetState;
  decls: DeclTable;
  moduleId: string;
  packageId: string;
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, DependencySemantics>;
  importsByLocal: Map<SymbolId, { moduleId: string; symbol: SymbolId }>;
  importAliasesByModule: Map<string, Map<SymbolId, SymbolId>>;
  typing: TypingResult;
}): TypingContext => ({
  symbolTable,
  hir,
  overloads,
  typeCheckBudget,
  decls,
  moduleId,
  packageId,
  moduleExports,
  dependencies,
  importsByLocal,
  importAliasesByModule,
  arena: typing.arena,
  table: typing.table,
  effects: typing.effects,
  resolvedExprTypes: new Map(typing.resolvedExprTypes),
  valueTypes: new Map(typing.valueTypes),
  activeValueTypeComputations: new Set(),
  tailResumptions: new Map(typing.tailResumptions),
  callResolution: {
    targets: cloneNestedMap(typing.callTargets),
    typeArguments: cloneNestedMap(typing.callTypeArguments),
    instanceKeys: cloneNestedMap(typing.callInstanceKeys),
    traitDispatches: new Set(typing.callTraitDispatches),
  },
  functions: typing.functions,
  objects: typing.objects,
  traits: typing.traits,
  typeAliases: typing.typeAliases,
  primitives: typing.primitives,
  intrinsicTypes: typing.intrinsicTypes,
  diagnostics: new DiagnosticEmitter(),
  memberMetadata: new Map(typing.memberMetadata),
  traitImplsByNominal: new Map(typing.traitImplsByNominal),
  traitImplsByTrait: new Map(typing.traitImplsByTrait),
  traitMethodImpls: new Map(typing.traitMethodImpls),
});
