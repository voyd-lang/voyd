import type {
  DocumentationItem,
  DocumentationItemKind,
  DocumentationMember,
  DocumentationModel,
  ModuleDocumentationSection,
} from "./types.js";

type VisibilityLike = {
  level?: string;
};

type ParameterLike = {
  name: string;
  label?: string;
  optional?: boolean;
  typeExpr?: unknown;
  documentation?: string;
};

type FunctionLike = {
  id: number;
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<ParameterLike>;
  returnTypeExpr?: unknown;
  effectTypeExpr?: unknown;
  documentation?: string;
};

type TypeAliasLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  target: unknown;
  documentation?: string;
};

type ObjectLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  baseTypeExpr?: unknown;
  fields: ReadonlyArray<{
    name: string;
    typeExpr: unknown;
    documentation?: string;
  }>;
  documentation?: string;
};

type TraitLike = {
  name: string;
  visibility: VisibilityLike;
  typeParameters?: ReadonlyArray<{ name: string }>;
  methods: ReadonlyArray<{
    name: string;
    params: ReadonlyArray<ParameterLike>;
    returnTypeExpr?: unknown;
    effectTypeExpr?: unknown;
    documentation?: string;
  }>;
  documentation?: string;
};

type ImplLike = {
  id: number;
  visibility: VisibilityLike;
  target: unknown;
  trait?: unknown;
  typeParameters?: ReadonlyArray<{ name: string }>;
  methods: ReadonlyArray<FunctionLike>;
  documentation?: string;
};

type ModuleDocumentationLike = {
  module?: string;
};

type ModuleNodeLike = {
  id: string;
  docs?: ModuleDocumentationLike;
};

export type DocumentationSemanticsLike = {
  binding: {
    packageId: string;
    functions: ReadonlyArray<FunctionLike>;
    typeAliases: ReadonlyArray<TypeAliasLike>;
    objects: ReadonlyArray<ObjectLike>;
    traits: ReadonlyArray<TraitLike>;
    impls: ReadonlyArray<ImplLike>;
  };
};

export type DocumentationGraphLike = {
  entry: string;
  modules: ReadonlyMap<string, ModuleNodeLike>;
};

const isPublic = (visibility: VisibilityLike | undefined): boolean =>
  visibility?.level === "public" || visibility?.level === "package";

const sanitizeAnchorSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const createAnchorGenerator = () => {
  const counts = new Map<string, number>();
  return (value: string): string => {
    const base = sanitizeAnchorSegment(value) || "item";
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };
};

const formatTypeExpr = (expr: unknown): string => {
  if (!expr) {
    return "<inferred>";
  }

  if (typeof expr === "string") {
    return expr;
  }

  if (typeof expr === "number" || typeof expr === "boolean") {
    return String(expr);
  }

  if (typeof expr !== "object") {
    return "<expr>";
  }

  const candidate = expr as {
    syntaxType?: string;
    value?: unknown;
    toArray?: () => unknown[];
  };

  if (
    (candidate.syntaxType === "identifier" ||
      candidate.syntaxType === "int" ||
      candidate.syntaxType === "float" ||
      candidate.syntaxType === "string" ||
      candidate.syntaxType === "bool") &&
    typeof candidate.value === "string"
  ) {
    return candidate.value;
  }

  if (
    (candidate.syntaxType === "form" || candidate.syntaxType === "call-form") &&
    typeof candidate.toArray === "function"
  ) {
    const entries = candidate.toArray();
    return `(${entries.map((entry) => formatTypeExpr(entry)).join(" ")})`;
  }

  return "<expr>";
};

const formatTypeParameters = (
  typeParameters: ReadonlyArray<{ name: string }> | undefined,
): string => {
  if (!typeParameters || typeParameters.length === 0) {
    return "";
  }
  return `<${typeParameters.map((parameter) => parameter.name).join(", ")}>`;
};

const formatParameterSignature = (parameter: ParameterLike): string => {
  const optionalMarker = parameter.optional ? "?" : "";
  const typeText = formatTypeExpr(parameter.typeExpr);
  if (parameter.label && parameter.label !== parameter.name) {
    return `${parameter.label} ${parameter.name}${optionalMarker}: ${typeText}`;
  }
  return `${parameter.name}${optionalMarker}: ${typeText}`;
};

const formatFunctionSignature = (fn: {
  name: string;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<ParameterLike>;
  effectTypeExpr?: unknown;
  returnTypeExpr?: unknown;
}): string => {
  const typeParams = formatTypeParameters(fn.typeParameters);
  const params = fn.params.map(formatParameterSignature).join(", ");
  const effectPart = fn.effectTypeExpr
    ? `: ${formatTypeExpr(fn.effectTypeExpr)}`
    : "";
  const returnPart = fn.returnTypeExpr
    ? ` -> ${formatTypeExpr(fn.returnTypeExpr)}`
    : "";
  return `fn ${fn.name}${typeParams}(${params})${effectPart}${returnPart}`;
};

const collectParameterDocs = (
  params: readonly ParameterLike[],
): Array<{ name: string; documentation: string }> =>
  params.flatMap((param) =>
    param.documentation === undefined
      ? []
      : [{ name: param.name, documentation: param.documentation }],
  );

const memberFromFunction = ({
  fn,
}: {
  fn: { name: string; params: ReadonlyArray<ParameterLike>; documentation?: string };
}): Omit<DocumentationMember, "anchor"> => ({
  name: fn.name,
  signature: formatFunctionSignature(fn),
  documentation: fn.documentation,
});

const createItem = ({
  moduleId,
  kind,
  name,
  signature,
  documentation,
  parameterDocs,
  members,
  nextAnchor,
}: {
  moduleId: string;
  kind: DocumentationItemKind;
  name: string;
  signature: string;
  documentation?: string;
  parameterDocs?: Array<{ name: string; documentation: string }>;
  members?: readonly Omit<DocumentationMember, "anchor">[];
  nextAnchor: (value: string) => string;
}): DocumentationItem => {
  const fqn = `${moduleId}::${name}`;
  const itemAnchor = nextAnchor(`${kind}-${fqn}`);
  const memberDocs = (members ?? []).map((member) => ({
    ...member,
    anchor: nextAnchor(`${itemAnchor}-member-${member.name}`),
  }));

  return {
    kind,
    name,
    fqn,
    signature,
    documentation,
    anchor: itemAnchor,
    parameterDocs: parameterDocs ?? [],
    members: memberDocs,
  };
};

const sortModules = (
  modules: readonly ModuleDocumentationSection[],
): ModuleDocumentationSection[] =>
  [...modules].sort((left, right) => left.id.localeCompare(right.id));

const moduleDepth = (moduleId: string): number => moduleId.split("::").length - 1;

export const createDocumentationModel = ({
  graph,
  semantics,
}: {
  graph: DocumentationGraphLike;
  semantics: ReadonlyMap<string, DocumentationSemanticsLike>;
}): DocumentationModel => {
  const nextAnchor = createAnchorGenerator();
  const entrySemantics = semantics.get(graph.entry);
  const packageId =
    entrySemantics?.binding.packageId ??
    semantics.values().next().value?.binding?.packageId;

  const modules = Array.from(semantics.keys()).flatMap((moduleId) => {
    const semantic = semantics.get(moduleId);
    if (!semantic) {
      return [];
    }
    if (packageId && semantic.binding.packageId !== packageId) {
      return [];
    }

    const moduleNode = graph.modules.get(moduleId);
    const moduleAnchor = nextAnchor(`module-${moduleId}`);

    const functions = semantic.binding.functions
      .filter((fn) => isPublic(fn.visibility))
      .map((fn) =>
        createItem({
          moduleId,
          kind: "function",
          name: fn.name,
          signature: formatFunctionSignature(fn),
          documentation: fn.documentation,
          parameterDocs: collectParameterDocs(fn.params),
          nextAnchor,
        }),
      );

    const typeAliases = semantic.binding.typeAliases
      .filter((typeAlias) => isPublic(typeAlias.visibility))
      .map((typeAlias) =>
        createItem({
          moduleId,
          kind: "type_alias",
          name: typeAlias.name,
          signature: `type ${typeAlias.name}${formatTypeParameters(
            typeAlias.typeParameters,
          )} = ${formatTypeExpr(typeAlias.target)}`,
          documentation: typeAlias.documentation,
          nextAnchor,
        }),
      );

    const objects = semantic.binding.objects
      .filter((objectDecl) => isPublic(objectDecl.visibility))
      .map((objectDecl) =>
        createItem({
          moduleId,
          kind: "object",
          name: objectDecl.name,
          signature: `obj ${objectDecl.name}${formatTypeParameters(
            objectDecl.typeParameters,
          )}${
            objectDecl.baseTypeExpr
              ? `: ${formatTypeExpr(objectDecl.baseTypeExpr)}`
              : ""
          }`,
          documentation: objectDecl.documentation,
          members: objectDecl.fields.map((field) => ({
            name: field.name,
            signature: `${field.name}: ${formatTypeExpr(field.typeExpr)}`,
            documentation: field.documentation,
          })),
          nextAnchor,
        }),
      );

    const traits = semantic.binding.traits
      .filter((traitDecl) => isPublic(traitDecl.visibility))
      .map((traitDecl) =>
        createItem({
          moduleId,
          kind: "trait",
          name: traitDecl.name,
          signature: `trait ${traitDecl.name}${formatTypeParameters(
            traitDecl.typeParameters,
          )}`,
          documentation: traitDecl.documentation,
          members: traitDecl.methods.map((method) => ({
            name: method.name,
            signature: formatFunctionSignature(method),
            documentation: method.documentation,
          })),
          nextAnchor,
        }),
      );

    const impls = semantic.binding.impls
      .filter((implDecl) => isPublic(implDecl.visibility))
      .map((implDecl) => {
        const implName = `impl#${implDecl.id}`;
        return createItem({
          moduleId,
          kind: "impl",
          name: implName,
          signature: `impl${formatTypeParameters(
            implDecl.typeParameters,
          )} ${formatTypeExpr(implDecl.target)}${
            implDecl.trait ? ` for ${formatTypeExpr(implDecl.trait)}` : ""
          }`,
          documentation: implDecl.documentation,
          members: implDecl.methods.map((method) => memberFromFunction({ fn: method })),
          nextAnchor,
        });
      });

    return [
      {
        id: moduleId,
        depth: moduleDepth(moduleId),
        anchor: moduleAnchor,
        documentation: moduleNode?.docs?.module,
        functions,
        typeAliases,
        objects,
        traits,
        impls,
      },
    ];
  });

  return {
    entryModule: graph.entry,
    generatedAt: new Date().toISOString(),
    modules: sortModules(modules),
  };
};
