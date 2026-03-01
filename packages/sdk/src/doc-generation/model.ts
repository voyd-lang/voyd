import type {
  DocumentationEffectOperationView,
  DocumentationFunctionView,
  DocumentationModuleLetView,
  DocumentationMethodView,
  DocumentationParameterView,
  DocumentationProgramView,
  DocumentationReExportView,
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

const isVisibleImpl = (visibility: { level?: string } | undefined): boolean =>
  visibility?.level === "public" ||
  visibility?.level === "package" ||
  visibility?.level === "module";

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

type SExpression = string | readonly SExpression[];

const parseSExpression = (value: string): SExpression | undefined => {
  let index = 0;
  const source = value.trim();

  const skipWhitespace = () => {
    while (index < source.length && /\s/.test(source[index] ?? "")) {
      index += 1;
    }
  };

  const parseNode = (): SExpression | undefined => {
    skipWhitespace();
    const current = source[index];
    if (!current) {
      return undefined;
    }

    if (current === "(") {
      index += 1;
      const entries: SExpression[] = [];
      while (index < source.length) {
        skipWhitespace();
        if ((source[index] ?? "") === ")") {
          index += 1;
          return entries;
        }
        const entry = parseNode();
        if (entry === undefined) {
          return undefined;
        }
        entries.push(entry);
      }
      return undefined;
    }

    let token = "";
    while (index < source.length) {
      const char = source[index]!;
      if (/\s/.test(char) || char === "(" || char === ")") {
        break;
      }
      token += char;
      index += 1;
    }
    return token.length > 0 ? token : undefined;
  };

  const parsed = parseNode();
  skipWhitespace();
  if (index !== source.length) {
    return undefined;
  }
  return parsed;
};

const isSExpressionList = (
  expr: SExpression,
): expr is readonly SExpression[] => Array.isArray(expr);

const sExpressionHead = (expr: SExpression): string | undefined =>
  isSExpressionList(expr) ? (typeof expr[0] === "string" ? expr[0] : undefined) : undefined;

const renderSExpression = (expr: SExpression): string => {
  if (!isSExpressionList(expr)) {
    return expr;
  }
  if (expr.length === 0) {
    return "()";
  }

  const [headValue, ...rest] = expr;
  const head = typeof headValue === "string" ? headValue : undefined;
  if (!head) {
    return `(${expr.map(renderSExpression).join(" ")})`;
  }

  if (head === "generics") {
    return `<${rest.map(renderSExpression).join(", ")}>`;
  }
  if (head === "tuple") {
    return `(${rest.map(renderSExpression).join(", ")})`;
  }
  if (head === "->") {
    if (rest.length === 0) {
      return "()";
    }
    const returnType = rest[rest.length - 1];
    const inputs = rest.slice(0, -1).flatMap((entry) => {
      if (isSExpressionList(entry) && sExpressionHead(entry) === "tuple") {
        return entry.slice(1);
      }
      return [entry];
    });
    return `(${inputs.map(renderSExpression).join(", ")}) -> ${renderSExpression(
      returnType!,
    )}`;
  }
  if (head === ":" && rest.length >= 2) {
    return `${renderSExpression(rest[0]!)}: ${renderSExpression(rest[1]!)}`;
  }

  if (rest.length === 0) {
    return head;
  }

  if (rest.length === 1 && isSExpressionList(rest[0]!) && sExpressionHead(rest[0]!) === "generics") {
    return `${head}${renderSExpression(rest[0]!)}`;
  }

  return `${head}(${rest.map(renderSExpression).join(", ")})`;
};

const identifierValue = (expr: unknown): string | undefined => {
  if (!expr || typeof expr !== "object") {
    return undefined;
  }
  const candidate = expr as {
    syntaxType?: string;
    value?: unknown;
  };
  if (candidate.syntaxType !== "identifier") {
    return undefined;
  }
  return typeof candidate.value === "string" ? candidate.value : undefined;
};

const formEntries = (expr: unknown): unknown[] | undefined => {
  if (!expr || typeof expr !== "object") {
    return undefined;
  }
  const candidate = expr as {
    syntaxType?: string;
    toArray?: () => unknown[];
  };
  if (
    (candidate.syntaxType !== "form" && candidate.syntaxType !== "call-form") ||
    typeof candidate.toArray !== "function"
  ) {
    return undefined;
  }
  return candidate.toArray();
};

const formatFunctionType = (parts: readonly unknown[]): string => {
  if (parts.length === 0) {
    return "()";
  }
  const returnType = parts[parts.length - 1];
  const inputParts = parts.slice(0, -1);
  const flattenedInputs = inputParts.flatMap((entry) => {
    const entries = formEntries(entry);
    if (!entries || entries.length === 0) {
      return [entry];
    }
    const head = identifierValue(entries[0]);
    if (head === "tuple") {
      return entries.slice(1);
    }
    return [entry];
  });

  return `(${flattenedInputs.map((entry) => formatTypeExpr(entry)).join(", ")}) -> ${formatTypeExpr(
    returnType,
  )}`;
};

const formatCallForm = (entries: readonly unknown[]): string => {
  if (entries.length === 0) {
    return "()";
  }

  const [head, ...rest] = entries;
  const headName = identifierValue(head);
  if (!headName) {
    return `(${entries.map((entry) => formatTypeExpr(entry)).join(" ")})`;
  }

  if (headName === "generics") {
    return `<${rest.map((entry) => formatTypeExpr(entry)).join(", ")}>`;
  }
  if (headName === "tuple") {
    return `(${rest.map((entry) => formatTypeExpr(entry)).join(", ")})`;
  }
  if (headName === "->") {
    return formatFunctionType(rest);
  }
  if (headName === ":" && rest.length >= 2) {
    return `${formatTypeExpr(rest[0])}: ${formatTypeExpr(rest[1])}`;
  }

  if (rest.length === 0) {
    return headName;
  }

  const maybeGenerics = formEntries(rest[0]);
  if (
    rest.length === 1 &&
    maybeGenerics &&
    maybeGenerics.length > 0 &&
    identifierValue(maybeGenerics[0]) === "generics"
  ) {
    return `${headName}${formatTypeExpr(rest[0])}`;
  }

  return `${headName}(${rest.map((entry) => formatTypeExpr(entry)).join(", ")})`;
};

const formatTypeExpr = (expr: unknown): string => {
  if (!expr) {
    return "<inferred>";
  }

  if (typeof expr === "string") {
    if (!expr.includes("(")) {
      return expr;
    }
    const parsed = parseSExpression(expr);
    if (parsed) {
      return renderSExpression(parsed);
    }
    return expr;
  }

  if (typeof expr === "number" || typeof expr === "boolean") {
    return String(expr);
  }

  const identifier = identifierValue(expr);
  if (identifier) {
    return identifier;
  }

  const entries = formEntries(expr);
  if (entries) {
    return formatCallForm(entries);
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

const formatLabeledParameterEntry = (
  parameter: DocumentationParameterView,
): string => {
  const renderedName = parameter.mutable ? `~${parameter.name}` : parameter.name;
  const optionalMarker = parameter.optional ? "?" : "";
  const typeText = formatTypeExpr(parameter.typeExpr);
  if (parameter.label === parameter.name) {
    return `${parameter.mutable ? `~${parameter.label}` : parameter.label}${optionalMarker}: ${typeText}`;
  }
  return `${parameter.label} ${renderedName}${optionalMarker}: ${typeText}`;
};

const formatParameterSignature = (
  parameter: DocumentationParameterView,
): string => {
  if (parameter.label) {
    return `{ ${formatLabeledParameterEntry(parameter)} }`;
  }
  const renderedName = parameter.mutable ? `~${parameter.name}` : parameter.name;
  const optionalMarker = parameter.optional ? "?" : "";
  const typeText = formatTypeExpr(parameter.typeExpr);
  return `${renderedName}${optionalMarker}: ${typeText}`;
};

type ParameterChunk =
  | { kind: "plain"; text: string }
  | { kind: "labeled-group"; entries: readonly string[] };

const buildParameterChunks = (
  params: readonly DocumentationParameterView[],
): ParameterChunk[] => {
  const chunks: ParameterChunk[] = [];

  let index = 0;
  while (index < params.length) {
    const parameter = params[index]!;
    if (!parameter.label) {
      chunks.push({ kind: "plain", text: formatParameterSignature(parameter) });
      index += 1;
      continue;
    }

    const entries: string[] = [];
    while (index < params.length) {
      const labeledParam = params[index]!;
      if (!labeledParam.label) {
        break;
      }
      entries.push(formatLabeledParameterEntry(labeledParam));
      index += 1;
    }
    chunks.push({ kind: "labeled-group", entries });
  }

  return chunks;
};

const renderParameterChunkInline = (chunk: ParameterChunk): string =>
  chunk.kind === "plain"
    ? chunk.text
    : `{ ${chunk.entries.join(", ")} }`;

const isComplexParameterChunk = (chunk: ParameterChunk): boolean =>
  chunk.kind === "labeled-group"
    ? chunk.entries.length > 1 || chunk.entries.some((entry) => entry.includes("->"))
    : chunk.text.includes("->");

const shouldMultilineSignature = ({
  header,
  chunks,
  effectPart,
  returnPart,
}: {
  header: string;
  chunks: readonly ParameterChunk[];
  effectPart: string;
  returnPart: string;
}): boolean => {
  const inlineParams = chunks.map(renderParameterChunkInline).join(", ");
  const inlineSignature = `${header}(${inlineParams})${effectPart}${returnPart}`;
  if (inlineSignature.length > 92) {
    return true;
  }

  const hasComplexChunk = chunks.some(isComplexParameterChunk);
  if (hasComplexChunk && chunks.length >= 2) {
    return true;
  }

  return chunks.some(
    (chunk) => chunk.kind === "labeled-group" && chunk.entries.length > 1,
  );
};

const renderParameterChunkMultiline = (chunk: ParameterChunk): string => {
  if (chunk.kind === "plain") {
    return `  ${chunk.text}`;
  }
  const entries = chunk.entries.map((entry) => `    ${entry}`).join("\n");
  return `  {\n${entries}\n  }`;
};

const formatCallableSignature = ({
  callableKeyword,
  name,
  typeParameters,
  params,
  effectTypeExpr,
  returnTypeExpr,
}: {
  callableKeyword?: string;
  name: string;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<DocumentationParameterView>;
  effectTypeExpr?: unknown;
  returnTypeExpr?: unknown;
}): string => {
  const typeParams = formatTypeParameters(typeParameters);
  const chunks = buildParameterChunks(params);
  const effectPart = effectTypeExpr
    ? `: ${formatTypeExpr(effectTypeExpr)}`
    : "";
  const returnPart = returnTypeExpr
    ? ` -> ${formatTypeExpr(returnTypeExpr)}`
    : "";
  const header = callableKeyword
    ? `${callableKeyword} ${name}${typeParams}`
    : `${name}${typeParams}`;

  if (
    !shouldMultilineSignature({
      header,
      chunks,
      effectPart,
      returnPart,
    })
  ) {
    const inlineParams = chunks.map(renderParameterChunkInline).join(", ");
    return `${header}(${inlineParams})${effectPart}${returnPart}`;
  }

  const multilineParams = chunks.map(renderParameterChunkMultiline).join(",\n");
  return `${header}(\n${multilineParams}\n)${effectPart}${returnPart}`;
};

const formatFunctionSignature = (fn: {
  name: string;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<DocumentationParameterView>;
  effectTypeExpr?: unknown;
  returnTypeExpr?: unknown;
}): string =>
  formatCallableSignature({
    callableKeyword: "fn",
    name: fn.name,
    typeParameters: fn.typeParameters,
    params: fn.params,
    effectTypeExpr: fn.effectTypeExpr,
    returnTypeExpr: fn.returnTypeExpr,
  });

const formatModuleLetSignature = (
  moduleLet: DocumentationModuleLetView,
): string =>
  `let ${moduleLet.name}${
    moduleLet.typeExpr ? `: ${formatTypeExpr(moduleLet.typeExpr)}` : ""
  }`;

const formatMethodSignature = (member: {
  name: string;
  typeParameters?: ReadonlyArray<{ name: string }>;
  params: ReadonlyArray<DocumentationParameterView>;
  effectTypeExpr?: unknown;
  returnTypeExpr?: unknown;
}): string =>
  formatCallableSignature({
    name: member.name,
    typeParameters: member.typeParameters,
    params: member.params,
    effectTypeExpr: member.effectTypeExpr,
    returnTypeExpr: member.returnTypeExpr,
  });

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
  signature: formatMethodSignature(method),
  documentation: method.documentation,
});

const memberFromImplMethod = ({
  fn,
}: {
  fn: DocumentationFunctionView;
}): Omit<DocumentationMember, "anchor"> => ({
  name: fn.name,
  signature: formatMethodSignature(fn),
  documentation: fn.documentation,
});

const formatEffectOperationSignature = (
  operation: DocumentationEffectOperationView,
): string => {
  const params = operation.params.map(formatParameterSignature);
  const allParams = [operation.resumable, ...params].join(", ");
  const returnPart = operation.returnTypeExpr
    ? ` -> ${formatTypeExpr(operation.returnTypeExpr)}`
    : "";
  return `${operation.name}(${allParams})${returnPart}`;
};

const defaultAliasForReExport = (
  reexport: DocumentationReExportView,
): string | undefined => {
  if (reexport.selectionKind === "all") {
    return undefined;
  }
  if (reexport.selectionKind === "name") {
    return reexport.targetName;
  }
  return reexport.path.at(-1);
};

const formatReExportPath = (reexport: DocumentationReExportView): string =>
  reexport.selectionKind === "all"
    ? `${reexport.path.join("::")}::all`
    : reexport.path.join("::");

const formatReExportSignature = (
  reexport: DocumentationReExportView,
): string => {
  const defaultAlias = defaultAliasForReExport(reexport);
  const aliasPart =
    reexport.alias && reexport.alias !== defaultAlias
      ? ` as ${reexport.alias}`
      : "";
  return `pub ${formatReExportPath(reexport)}${aliasPart}`;
};

const extractTargetName = (targetTypeExpr: unknown): string | undefined => {
  const typeText = formatTypeExpr(targetTypeExpr).trim();
  if (typeText.length === 0 || typeText.startsWith("(")) {
    return undefined;
  }

  const candidate = typeText.split("<")[0]?.trim();
  if (!candidate) {
    return undefined;
  }

  const lastSegment = candidate.split("::").at(-1)?.trim();
  if (!lastSegment || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(lastSegment)) {
    return undefined;
  }
  return lastSegment;
};

const createItem = ({
  moduleId,
  kind,
  name,
  signature,
  targetName,
  documentation,
  parameterDocs,
  members,
  nextAnchor,
}: {
  moduleId: string;
  kind: DocumentationItemKind;
  name: string;
  signature: string;
  targetName?: string;
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
    targetName,
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
    const localPrivateTypeNames = new Set([
      ...moduleDoc.typeAliases
        .filter((typeAlias) => !isPublic(typeAlias.visibility))
        .map((typeAlias) => typeAlias.name),
      ...moduleDoc.objects
        .filter((objectDecl) => !isPublic(objectDecl.visibility))
        .map((objectDecl) => objectDecl.name),
      ...moduleDoc.traits
        .filter((traitDecl) => !isPublic(traitDecl.visibility))
        .map((traitDecl) => traitDecl.name),
      ...moduleDoc.effects
        .filter((effectDecl) => !isPublic(effectDecl.visibility))
        .map((effectDecl) => effectDecl.name),
    ]);

    const functions = moduleDoc.functions
      .filter(
        (fn) => isPublic(fn.visibility) && fn.implId === undefined,
      )
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

    const macros = moduleDoc.macros
      .map((macro) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "macro",
          name: macro.name,
          signature: `macro ${macro.name}`,
          documentation: macro.documentation,
          nextAnchor,
        }),
      );

    const moduleLets = moduleDoc.moduleLets
      .filter((moduleLet) => isPublic(moduleLet.visibility))
      .map((moduleLet) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "module_let",
          name: moduleLet.name,
          signature: formatModuleLetSignature(moduleLet),
          documentation: moduleLet.documentation,
          nextAnchor,
        }),
      );

    const reexports = moduleDoc.reexports
      .filter((reexport) => isPublic(reexport.visibility))
      .map((reexport, index) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "re_export",
          name: `reexport#${index}`,
          signature: formatReExportSignature(reexport),
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

    const effects = moduleDoc.effects
      .filter((effectDecl) => isPublic(effectDecl.visibility))
      .map((effectDecl) =>
        createItem({
          moduleId: moduleDoc.id,
          kind: "effect",
          name: effectDecl.name,
          signature: `eff ${effectDecl.name}${formatTypeParameters(
            effectDecl.typeParameters,
          )}`,
          documentation: effectDecl.documentation,
          members: effectDecl.operations.map((operation) => ({
            name: operation.name,
            signature: formatEffectOperationSignature(operation),
            documentation: operation.documentation,
          })),
          nextAnchor,
        }),
      );

    const impls = moduleDoc.impls
      .filter((implDecl) => {
        if (!isVisibleImpl(implDecl.visibility)) {
          return false;
        }
        const targetName = extractTargetName(implDecl.target);
        if (!targetName) {
          return true;
        }
        if (localPrivateTypeNames.has(targetName)) {
          return false;
        }
        // If the target type is not known to be private in this module,
        // keep the impl. This preserves extension impls for dependency types.
        return true;
      })
      .map((implDecl) => {
        const implName = `impl#${implDecl.id}`;
        return createItem({
          moduleId: moduleDoc.id,
          kind: "impl",
          name: implName,
          targetName: extractTargetName(implDecl.target),
          signature: `impl${formatTypeParameters(
            implDecl.typeParameters,
          )} ${formatTypeExpr(implDecl.target)}${
            implDecl.trait ? ` for ${formatTypeExpr(implDecl.trait)}` : ""
          }`,
          documentation: implDecl.documentation,
          members: implDecl.methods.map((method) =>
            memberFromImplMethod({ fn: method }),
          ),
          nextAnchor,
        });
      });

    return {
      id: moduleDoc.id,
      depth: moduleDoc.depth,
      anchor: moduleAnchor,
      documentation: moduleDoc.documentation,
      macros,
      reexports,
      moduleLets,
      functions,
      typeAliases,
      objects,
      traits,
      effects,
      impls,
    };
  });

  return {
    entryModule: program.entryModule,
    generatedAt: new Date().toISOString(),
    modules: sortModules(modules),
  };
};
