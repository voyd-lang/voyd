import type {
  DocumentationFunctionView,
  DocumentationMethodView,
  DocumentationParameterView,
  DocumentationProgramView,
} from "@voyd/compiler/docs/documentation-view.js";
import type {
  DocumentationItem,
  DocumentationItemKind,
  DocumentationMember,
  DocumentationModel,
  ModuleDocumentationSection,
} from "./types.js";

const isPublic = (visibility: { level?: string } | undefined): boolean =>
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

const formatParameterSignature = (
  parameter: DocumentationParameterView,
): string => {
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
  params: ReadonlyArray<DocumentationParameterView>;
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
  params: readonly DocumentationParameterView[],
): Array<{ name: string; documentation: string }> =>
  params.flatMap((param) =>
    param.documentation === undefined
      ? []
      : [{ name: param.name, documentation: param.documentation }],
  );

const memberFromMethod = ({
  method,
}: {
  method: DocumentationMethodView;
}): Omit<DocumentationMember, "anchor"> => ({
  name: method.name,
  signature: formatFunctionSignature(method),
  documentation: method.documentation,
});

const memberFromFunction = ({
  fn,
}: {
  fn: DocumentationFunctionView;
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

export const createDocumentationModel = ({
  program,
}: {
  program: DocumentationProgramView;
}): DocumentationModel => {
  const nextAnchor = createAnchorGenerator();

  const modules = program.modules.map((moduleDoc) => {
    const moduleAnchor = nextAnchor(`module-${moduleDoc.id}`);

    const functions = moduleDoc.functions
      .filter((fn) => isPublic(fn.visibility))
      .map((fn) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "function",
          name: fn.name,
          signature: formatFunctionSignature(fn),
          documentation: fn.documentation,
          parameterDocs: collectParameterDocs(fn.params),
          nextAnchor,
        }),
      );

    const typeAliases = moduleDoc.typeAliases
      .filter((typeAlias) => isPublic(typeAlias.visibility))
      .map((typeAlias) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "type_alias",
          name: typeAlias.name,
          signature: `type ${typeAlias.name}${formatTypeParameters(
            typeAlias.typeParameters,
          )} = ${formatTypeExpr(typeAlias.target)}`,
          documentation: typeAlias.documentation,
          nextAnchor,
        }),
      );

    const objects = moduleDoc.objects
      .filter((objectDecl) => isPublic(objectDecl.visibility))
      .map((objectDecl) =>
        createItem({
          moduleId: moduleDoc.id,
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

    const traits = moduleDoc.traits
      .filter((traitDecl) => isPublic(traitDecl.visibility))
      .map((traitDecl) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "trait",
          name: traitDecl.name,
          signature: `trait ${traitDecl.name}${formatTypeParameters(
            traitDecl.typeParameters,
          )}`,
          documentation: traitDecl.documentation,
          members: traitDecl.methods.map((method) =>
            memberFromMethod({ method }),
          ),
          nextAnchor,
        }),
      );

    const impls = moduleDoc.impls
      .filter((implDecl) => isPublic(implDecl.visibility))
      .map((implDecl) => {
        const implName = `impl#${implDecl.id}`;
        return createItem({
          moduleId: moduleDoc.id,
          kind: "impl",
          name: implName,
          signature: `impl${formatTypeParameters(
            implDecl.typeParameters,
          )} ${formatTypeExpr(implDecl.target)}${
            implDecl.trait ? ` for ${formatTypeExpr(implDecl.trait)}` : ""
          }`,
          documentation: implDecl.documentation,
          members: implDecl.methods.map((method) =>
            memberFromFunction({ fn: method }),
          ),
          nextAnchor,
        });
      });

    return {
      id: moduleDoc.id,
      depth: moduleDoc.depth,
      anchor: moduleAnchor,
      documentation: moduleDoc.documentation,
      functions,
      typeAliases,
      objects,
      traits,
      impls,
    };
  });

  return {
    entryModule: program.entryModule,
    generatedAt: new Date().toISOString(),
    modules: sortModules(modules),
  };
};
