import type { ModuleGraph } from "../modules/types.js";
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

export type DocumentationModuleView = {
  id: string;
  depth: number;
  packageId: string;
  documentation?: string;
  functions: readonly DocumentationFunctionView[];
  typeAliases: readonly DocumentationTypeAliasView[];
  objects: readonly DocumentationObjectView[];
  traits: readonly DocumentationTraitView[];
  effects: readonly DocumentationEffectView[];
  impls: readonly DocumentationImplView[];
};

export type DocumentationProgramView = {
  entryModule: string;
  packageId?: string;
  modules: readonly DocumentationModuleView[];
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
    optional?: boolean;
    typeExpr?: unknown;
    documentation?: string;
  },
): DocumentationParameterView => ({
  name: parameter.name,
  label: parameter.label,
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
}: {
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  packageId?: string;
}): DocumentationModuleView[] =>
  Array.from(semantics.entries())
    .flatMap(([moduleId, semantic]) => {
      if (packageId && semantic.binding.packageId !== packageId) {
        return [];
      }

      return [
        {
          id: moduleId,
          depth: moduleDepth(moduleId),
          packageId: semantic.binding.packageId,
          documentation: graph.modules.get(moduleId)?.docs?.module,
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
            fields: objectDecl.fields.map((field) => ({
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
            })),
          })),
          impls: semantic.binding.impls.map((implDecl) => ({
            id: implDecl.id,
            visibility: normalizeVisibility(implDecl.visibility),
            target: implDecl.target,
            trait: implDecl.trait,
            typeParameters: normalizeTypeParameters(implDecl.typeParameters),
            methods: implDecl.methods.map(normalizeFunction),
            documentation: implDecl.documentation,
          })),
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

  return {
    entryModule: graph.entry,
    packageId: resolvedPackageId,
    modules: normalizeModules({
      graph,
      semantics,
      packageId: resolvedPackageId,
    }),
  };
};
