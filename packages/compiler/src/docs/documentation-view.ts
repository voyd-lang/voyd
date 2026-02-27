import type { ModuleGraph } from "../modules/types.js";
import { classifyTopLevelDecl } from "../modules/use-decl.js";
import type { UsePathSelectionKind } from "../modules/use-path.js";
import { isForm, isIdentifierAtom } from "../parser/index.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";

export type DocumentationVisibilityView = {
  level?: string;
};

export type DocumentationTypeParameterView = {
  name: string;
};

export type DocumentationParameterView = {
  name: string;
  label?: string;
  mutable?: boolean;
  optional?: boolean;
  typeExpr?: unknown;
  documentation?: string;
};

export type DocumentationFunctionView = {
  id: number;
  name: string;
  visibility: DocumentationVisibilityView;
  implId?: number;
  typeParameters?: readonly DocumentationTypeParameterView[];
  params: readonly DocumentationParameterView[];
  returnTypeExpr?: unknown;
  effectTypeExpr?: unknown;
  documentation?: string;
};

export type DocumentationMethodView = {
  name: string;
  typeParameters?: readonly DocumentationTypeParameterView[];
  params: readonly DocumentationParameterView[];
  returnTypeExpr?: unknown;
  effectTypeExpr?: unknown;
  documentation?: string;
};

export type DocumentationTypeAliasView = {
  name: string;
  visibility: DocumentationVisibilityView;
  typeParameters?: readonly DocumentationTypeParameterView[];
  target: unknown;
  documentation?: string;
};

export type DocumentationObjectFieldView = {
  name: string;
  typeExpr: unknown;
  documentation?: string;
};

export type DocumentationObjectView = {
  name: string;
  visibility: DocumentationVisibilityView;
  typeParameters?: readonly DocumentationTypeParameterView[];
  baseTypeExpr?: unknown;
  fields: readonly DocumentationObjectFieldView[];
  documentation?: string;
};

export type DocumentationTraitView = {
  name: string;
  visibility: DocumentationVisibilityView;
  typeParameters?: readonly DocumentationTypeParameterView[];
  methods: readonly DocumentationMethodView[];
  documentation?: string;
};

export type DocumentationEffectOperationView = {
  name: string;
  params: readonly DocumentationParameterView[];
  returnTypeExpr?: unknown;
  resumable: "resume" | "tail";
  documentation?: string;
};

export type DocumentationEffectView = {
  name: string;
  visibility: DocumentationVisibilityView;
  typeParameters?: readonly DocumentationTypeParameterView[];
  operations: readonly DocumentationEffectOperationView[];
};

export type DocumentationImplView = {
  id: number;
  visibility: DocumentationVisibilityView;
  target: unknown;
  trait?: unknown;
  typeParameters?: readonly DocumentationTypeParameterView[];
  methods: readonly DocumentationFunctionView[];
  documentation?: string;
};

export type DocumentationReExportView = {
  visibility: DocumentationVisibilityView;
  path: readonly string[];
  moduleId?: string;
  selectionKind: UsePathSelectionKind;
  targetName?: string;
  alias?: string;
};

export type DocumentationMacroView = {
  name: string;
  documentation?: string;
};

export type DocumentationModuleView = {
  id: string;
  depth: number;
  packageId: string;
  documentation?: string;
  macros: readonly DocumentationMacroView[];
  functions: readonly DocumentationFunctionView[];
  typeAliases: readonly DocumentationTypeAliasView[];
  objects: readonly DocumentationObjectView[];
  traits: readonly DocumentationTraitView[];
  effects: readonly DocumentationEffectView[];
  impls: readonly DocumentationImplView[];
  reexports: readonly DocumentationReExportView[];
};

export type DocumentationProgramView = {
  entryModule: string;
  packageId?: string;
  modules: readonly DocumentationModuleView[];
};

const isDocumentedVisibility = (
  visibility: DocumentationVisibilityView | undefined,
): boolean =>
  visibility?.level === "public" || visibility?.level === "package";

type ExportedModuleRef = {
  moduleId: string;
  traversable: boolean;
};

const collectDirectExportedModuleIds = (
  semantics: SemanticsPipelineResult,
): readonly ExportedModuleRef[] => {
  const exportedModuleIds: ExportedModuleRef[] = [];

  semantics.exports.forEach((entry) => {
    if (entry.kind !== "module" || !isDocumentedVisibility(entry.visibility)) {
      return;
    }
    exportedModuleIds.push({
      moduleId: entry.moduleId,
      traversable: true,
    });
  });

  semantics.binding.uses.forEach((useDecl) => {
    if (!isDocumentedVisibility(useDecl.visibility)) {
      return;
    }
    useDecl.entries.forEach((entry) => {
      if (!entry.moduleId) {
        return;
      }
      exportedModuleIds.push({
        moduleId: entry.moduleId,
        traversable:
          entry.selectionKind === "all" || entry.selectionKind === "module",
      });
    });
  });

  return exportedModuleIds;
};

const collectPublicChildModuleIds = ({
  moduleId,
  graph,
}: {
  moduleId: string;
  graph: ModuleGraph;
}): readonly string[] => {
  const module = graph.modules.get(moduleId);
  if (!module) {
    return [];
  }

  const entries = module.ast.callsInternal("ast")
    ? module.ast.rest
    : module.ast.toArray();

  return entries.flatMap((entry) => {
    if (!isForm(entry)) {
      return [];
    }

    const classified = classifyTopLevelDecl(entry);
    if (classified.kind === "inline-module-decl" && classified.visibility === "pub") {
      return [`${moduleId}::${classified.name}`];
    }

    if (classified.kind !== "unsupported-mod-decl" || classified.visibility !== "pub") {
      return [];
    }

    const first = entry.at(0);
    const visibilityOffset =
      isIdentifierAtom(first) && first.value === "pub" ? 1 : 0;
    const nameExpr = entry.at(visibilityOffset + 1);
    if (!isIdentifierAtom(nameExpr)) {
      return [];
    }
    return [`${moduleId}::${nameExpr.value}`];
  });
};

const collectExportedModuleIds = ({
  entryModule,
  graph,
  semantics,
}: {
  entryModule: string;
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
}): Set<string> | undefined => {
  const entrySemantics = semantics.get(entryModule);
  if (!entrySemantics?.binding.isPackageRoot) {
    return undefined;
  }

  const exportedModuleIds = new Set<string>([entryModule]);
  const traversableByModuleId = new Map<string, boolean>([[entryModule, true]]);
  const queue: string[] = [entryModule];

  const includeModule = ({
    moduleId,
    traversable,
  }: {
    moduleId: string;
    traversable: boolean;
  }) => {
    if (!semantics.has(moduleId)) {
      return;
    }

    exportedModuleIds.add(moduleId);

    const wasTraversable = traversableByModuleId.get(moduleId) === true;
    if (!wasTraversable && traversable) {
      traversableByModuleId.set(moduleId, true);
      queue.push(moduleId);
      return;
    }

    if (!traversableByModuleId.has(moduleId)) {
      traversableByModuleId.set(moduleId, traversable);
    }
  };

  while (queue.length > 0) {
    const moduleId = queue.shift();
    if (!moduleId) {
      continue;
    }

    const moduleSemantics = semantics.get(moduleId);
    if (!moduleSemantics) {
      continue;
    }

    const directExportedModules = [
      ...collectDirectExportedModuleIds(moduleSemantics),
      ...collectPublicChildModuleIds({ moduleId, graph }).map((childModuleId) => ({
        moduleId: childModuleId,
        traversable: true,
      })),
    ];

    directExportedModules.forEach(includeModule);
  }

  return exportedModuleIds;
};

const moduleDepth = (moduleId: string): number => moduleId.split("::").length - 1;

const normalizeTypeParameters = (
  typeParameters: ReadonlyArray<{ name: string }> | undefined,
): readonly DocumentationTypeParameterView[] | undefined =>
  typeParameters?.map((parameter) => ({ name: parameter.name }));

const normalizeVisibility = (
  visibility: { level?: string } | undefined,
): DocumentationVisibilityView => ({
  level: visibility?.level,
});

const normalizeParameter = (
  parameter: {
    name: string;
    label?: string;
    bindingKind?: string;
    optional?: boolean;
    typeExpr?: unknown;
    documentation?: string;
  },
): DocumentationParameterView => ({
  name: parameter.name,
  label: parameter.label,
  mutable: parameter.bindingKind === "mutable-ref",
  optional: parameter.optional,
  typeExpr: parameter.typeExpr,
  documentation: parameter.documentation,
});

const normalizeFunction = (
  fn: {
    id: number;
    name: string;
    visibility: { level?: string };
    implId?: number;
    typeParameters?: ReadonlyArray<{ name: string }>;
    params: ReadonlyArray<{
      name: string;
      label?: string;
      bindingKind?: string;
      optional?: boolean;
      typeExpr?: unknown;
      documentation?: string;
    }>;
    returnTypeExpr?: unknown;
    effectTypeExpr?: unknown;
    documentation?: string;
  },
): DocumentationFunctionView => ({
  id: fn.id,
  name: fn.name,
  visibility: normalizeVisibility(fn.visibility),
  implId: fn.implId,
  typeParameters: normalizeTypeParameters(fn.typeParameters),
  params: fn.params.map(normalizeParameter),
  returnTypeExpr: fn.returnTypeExpr,
  effectTypeExpr: fn.effectTypeExpr,
  documentation: fn.documentation,
});

const normalizeMethod = (
  method: {
    name: string;
    typeParameters?: ReadonlyArray<{ name: string }>;
    params: ReadonlyArray<{
      name: string;
      label?: string;
      bindingKind?: string;
      optional?: boolean;
      typeExpr?: unknown;
      documentation?: string;
    }>;
    returnTypeExpr?: unknown;
    effectTypeExpr?: unknown;
    documentation?: string;
  },
): DocumentationMethodView => ({
  name: method.name,
  typeParameters: normalizeTypeParameters(method.typeParameters),
  params: method.params.map(normalizeParameter),
  returnTypeExpr: method.returnTypeExpr,
  effectTypeExpr: method.effectTypeExpr,
  documentation: method.documentation,
});

const normalizeModules = ({
  graph,
  semantics,
  packageId,
  includedModuleIds,
}: {
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  packageId?: string;
  includedModuleIds?: ReadonlySet<string>;
}): DocumentationModuleView[] =>
  Array.from(semantics.entries())
    .flatMap(([moduleId, semantic]) => {
      if (packageId && semantic.binding.packageId !== packageId) {
        return [];
      }
      if (includedModuleIds && !includedModuleIds.has(moduleId)) {
        return [];
      }
      const moduleNode = graph.modules.get(moduleId);
      const macroDocsByName = moduleNode?.docs?.macroDeclarationsByName;

      return [
        {
          id: moduleId,
          depth: moduleDepth(moduleId),
          packageId: semantic.binding.packageId,
          documentation: moduleNode?.docs?.module,
          macros: (moduleNode?.macroExports ?? []).map((name) => ({
            name,
            documentation: macroDocsByName?.get(name),
          })),
          functions: semantic.binding.functions.map(normalizeFunction),
          typeAliases: semantic.binding.typeAliases.map((typeAlias) => ({
            name: typeAlias.name,
            visibility: normalizeVisibility(typeAlias.visibility),
            typeParameters: normalizeTypeParameters(typeAlias.typeParameters),
            target: typeAlias.target,
            documentation: typeAlias.documentation,
          })),
          objects: semantic.binding.objects.map((objectDecl) => ({
            name: objectDecl.name,
            visibility: normalizeVisibility(objectDecl.visibility),
            typeParameters: normalizeTypeParameters(objectDecl.typeParameters),
            baseTypeExpr: objectDecl.baseTypeExpr,
            fields: objectDecl.fields
              .filter((field) => field.visibility.api === true)
              .map((field) => ({
                name: field.name,
                typeExpr: field.typeExpr,
                documentation: field.documentation,
              })),
            documentation: objectDecl.documentation,
          })),
          traits: semantic.binding.traits.map((traitDecl) => ({
            name: traitDecl.name,
            visibility: normalizeVisibility(traitDecl.visibility),
            typeParameters: normalizeTypeParameters(traitDecl.typeParameters),
            methods: traitDecl.methods.map(normalizeMethod),
            documentation: traitDecl.documentation,
          })),
          effects: semantic.binding.effects.map((effectDecl) => ({
            name: effectDecl.name,
            visibility: normalizeVisibility(effectDecl.visibility),
            typeParameters: normalizeTypeParameters(effectDecl.typeParameters),
            operations: effectDecl.operations.map((operation) => ({
              name: operation.name,
              params: operation.parameters.map(normalizeParameter),
              returnTypeExpr: operation.returnTypeExpr,
              resumable: operation.resumable,
              documentation: operation.documentation,
            })),
          })),
          impls: semantic.binding.impls.map((implDecl) => ({
            id: implDecl.id,
            visibility: normalizeVisibility(implDecl.visibility),
            target: implDecl.target,
            trait: implDecl.trait,
            typeParameters: normalizeTypeParameters(implDecl.typeParameters),
            methods: implDecl.methods
              .filter((method) => method.memberVisibility?.api === true)
              .map(normalizeFunction),
            documentation: implDecl.documentation,
          })),
          reexports: semantic.binding.uses.flatMap((useDecl) =>
            useDecl.entries.map((entry) => ({
              visibility: normalizeVisibility(useDecl.visibility),
              path: entry.path,
              moduleId: entry.moduleId,
              selectionKind: entry.selectionKind,
              targetName: entry.targetName,
              alias: entry.alias,
            })),
          ),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));

export const buildDocumentationView = ({
  graph,
  semantics,
  packageId,
}: {
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  packageId?: string;
}): DocumentationProgramView => {
  const resolvedPackageId =
    packageId ??
    semantics.get(graph.entry)?.binding.packageId ??
    semantics.values().next().value?.binding?.packageId;

  const includedModuleIds = collectExportedModuleIds({
    entryModule: graph.entry,
    graph,
    semantics,
  });

  return {
    entryModule: graph.entry,
    packageId: resolvedPackageId,
    modules: normalizeModules({
      graph,
      semantics,
      packageId: resolvedPackageId,
      includedModuleIds,
    }),
  };
};
