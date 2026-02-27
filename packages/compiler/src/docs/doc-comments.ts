import { diagnosticFromCode, type Diagnostic } from "../diagnostics/index.js";
import { classifyTopLevelDecl } from "../modules/use-decl.js";
import {
  type Form,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseImplDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "../semantics/binding/parsing.js";

type LineKind =
  | "blank"
  | "outer-doc"
  | "inner-doc"
  | "regular-comment"
  | "code";

type SourceLine = {
  lineNumber: number;
  startIndex: number;
  endIndex: number;
  kind: LineKind;
  docText?: string;
};

type DocTarget = {
  syntaxId: number;
  startColumn: number;
};

type IndexRange = {
  start: number;
  end: number;
};

type ExcludedLineRange = {
  startLineExclusive: number;
  endLineInclusive: number;
};

type OuterDocBlock = {
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  text: string;
};

export interface ModuleDocumentation {
  module?: string;
  declarationsBySyntaxId: ReadonlyMap<number, string>;
  parametersBySyntaxId: ReadonlyMap<number, string>;
  macroDeclarationsByName: ReadonlyMap<string, string>;
}

export interface ModuleDocumentationResult {
  documentation: ModuleDocumentation;
  diagnostics: readonly Diagnostic[];
}

export const combineDocumentation = (
  ...segments: Array<string | undefined>
): string | undefined => {
  const present = segments.filter(
    (segment): segment is string => segment !== undefined,
  );
  if (present.length === 0) {
    return undefined;
  }
  return present.join("\n\n");
};

const splitSourceLines = (source: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let lineNumber = 1;
  let lineStart = 0;

  for (let index = 0; index <= source.length; index += 1) {
    const isBreak = index === source.length || source[index] === "\n";
    if (!isBreak) {
      continue;
    }

    const raw = source.slice(lineStart, index);
    const normalized = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmedStart = normalized.trimStart();

    const line = {
      lineNumber,
      startIndex: lineStart,
      endIndex: index,
      kind: "code" as LineKind,
      docText: undefined as string | undefined,
    };

    if (trimmedStart.length === 0) {
      line.kind = "blank";
    } else if (trimmedStart.startsWith("///")) {
      line.kind = "outer-doc";
      line.docText = trimmedStart.slice(3);
    } else if (trimmedStart.startsWith("//!")) {
      line.kind = "inner-doc";
      line.docText = trimmedStart.slice(3);
    } else if (trimmedStart.startsWith("//")) {
      line.kind = "regular-comment";
    }

    lines.push(line);
    lineStart = index + 1;
    lineNumber += 1;
  }

  return lines;
};

const addTarget = (
  map: Map<number, DocTarget[]>,
  syntax: Syntax | undefined,
  opts: {
    moduleFilePath: string;
    moduleRange: IndexRange;
    isExcluded: (lineNumber: number) => boolean;
  },
) => {
  const location = syntax?.location;
  if (!location) {
    return;
  }
  if (location.filePath !== opts.moduleFilePath) {
    return;
  }
  if (
    location.startIndex < opts.moduleRange.start ||
    location.startIndex >= opts.moduleRange.end
  ) {
    return;
  }
  if (opts.isExcluded(location.startLine)) {
    return;
  }

  const targets = map.get(location.startLine) ?? [];
  targets.push({
    syntaxId: syntax.syntaxId,
    startColumn: location.startColumn,
  });
  targets.sort((left, right) => left.startColumn - right.startColumn);
  map.set(location.startLine, targets);
};

const collectNestedModuleRanges = ({
  ast,
  moduleFilePath,
}: {
  ast: Form;
  moduleFilePath: string;
}): ExcludedLineRange[] => {
  const entries = ast.callsInternal("ast") ? ast.rest : ast.toArray();

  return entries.flatMap((entry) => {
    if (!isForm(entry)) {
      return [];
    }
    const classified = classifyTopLevelDecl(entry);
    if (classified.kind !== "inline-module-decl") {
      return [];
    }
    const location = classified.body.location;
    if (!location || location.filePath !== moduleFilePath) {
      return [];
    }
    const entryLocation = entry.location;
    if (!entryLocation) {
      return [];
    }
    return [
      {
        startLineExclusive: entryLocation.startLine,
        endLineInclusive: location.endLine,
      },
    ];
  });
};

const inRange = (index: number, range: IndexRange): boolean =>
  index >= range.start && index < range.end;

const buildOuterBlocks = ({
  lines,
  moduleRange,
  isExcluded,
}: {
  lines: readonly SourceLine[];
  moduleRange: IndexRange;
  isExcluded: (lineNumber: number) => boolean;
}): OuterDocBlock[] => {
  const blocks: OuterDocBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const eligible =
      line.kind === "outer-doc" &&
      inRange(line.startIndex, moduleRange) &&
      !isExcluded(line.lineNumber);
    if (!eligible) {
      index += 1;
      continue;
    }

    const blockLines: SourceLine[] = [line];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor]!;
      const contiguous = next.lineNumber === blockLines.at(-1)!.lineNumber + 1;
      const nextEligible =
        contiguous &&
        next.kind === "outer-doc" &&
        inRange(next.startIndex, moduleRange) &&
        !isExcluded(next.lineNumber);
      if (!nextEligible) {
        break;
      }
      blockLines.push(next);
      cursor += 1;
    }

    blocks.push({
      startLine: blockLines[0]!.lineNumber,
      endLine: blockLines.at(-1)!.lineNumber,
      startIndex: blockLines[0]!.startIndex,
      endIndex: blockLines.at(-1)!.endIndex,
      text: blockLines.map((entry) => entry.docText ?? "").join("\n"),
    });
    index = cursor;
  }

  return blocks;
};

const firstTargetForLine = (
  map: ReadonlyMap<number, readonly DocTarget[]>,
  lineNumber: number,
): DocTarget | undefined => map.get(lineNumber)?.[0];

const parseMacroDeclarationName = (
  form: Form,
): { name: string; syntax: Syntax } | undefined => {
  let index = 0;
  const first = form.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") {
    index = 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "macro") {
    return undefined;
  }

  const signature = form.at(index + 1);
  if (!isForm(signature)) {
    return undefined;
  }

  const name = signature.at(0);
  if (!isIdentifierAtom(name)) {
    return undefined;
  }

  return {
    name: name.value,
    syntax: name,
  };
};

const collectDocTargets = ({
  ast,
  declarationTargets,
  parameterTargets,
  moduleFilePath,
  moduleRange,
  isExcluded,
}: {
  ast: Form;
  declarationTargets: Map<number, DocTarget[]>;
  parameterTargets: Map<number, DocTarget[]>;
  moduleFilePath: string;
  moduleRange: IndexRange;
  isExcluded: (lineNumber: number) => boolean;
}) => {
  const addDeclaration = (syntax: Syntax | undefined): void =>
    addTarget(declarationTargets, syntax, {
      moduleFilePath,
      moduleRange,
      isExcluded,
    });
  const addParameter = (syntax: Syntax | undefined): void =>
    addTarget(parameterTargets, syntax, {
      moduleFilePath,
      moduleRange,
      isExcluded,
    });

  const entries = ast.callsInternal("ast") ? ast.rest : ast.toArray();
  entries.forEach((entry) => {
    if (!isForm(entry)) {
      return;
    }

    const classified = classifyTopLevelDecl(entry);
    if (classified.kind === "macro-decl") {
      addDeclaration(parseMacroDeclarationName(entry)?.syntax);
      return;
    }

    if (
      classified.kind === "inline-module-decl" ||
      classified.kind === "unsupported-mod-decl"
    ) {
      const first = entry.at(0);
      const visibilityOffset =
        isIdentifierAtom(first) && first.value === "pub" ? 1 : 0;
      addDeclaration((entry.at(visibilityOffset + 1) as Syntax | undefined) ?? entry);
    }

    try {
      const parsed = parseFunctionDecl(entry);
      if (parsed) {
        addDeclaration(parsed.signature.name);
        parsed.signature.params.forEach((param) => addParameter(param.ast));
        return;
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }

    try {
      const parsed = parseTypeAliasDecl(entry);
      if (parsed) {
        addDeclaration(parsed.name);
        return;
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }

    try {
      const parsed = parseObjectDecl(entry);
      if (parsed) {
        addDeclaration(parsed.name);
        parsed.fields.forEach((field) => addDeclaration(field.name));
        return;
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }

    try {
      const parsed = parseTraitDecl(entry);
      if (parsed) {
        addDeclaration(parsed.name);
        parsed.methods.forEach((method) => {
          addDeclaration(method.signature.name);
          method.signature.params.forEach((param) => addParameter(param.ast));
        });
        return;
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }

    try {
      const parsed = parseEffectDecl(entry);
      if (parsed) {
        addDeclaration(parsed.name);
        parsed.operations.forEach((operation) => {
          addDeclaration(operation.name);
          operation.params.forEach((param) => addParameter(param.ast));
        });
        return;
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }

    try {
      const parsed = parseImplDecl(entry);
      if (parsed) {
        addDeclaration(parsed.target as Syntax);
        parsed.body.rest.forEach((candidate) => {
          if (!isForm(candidate)) {
            return;
          }
          try {
            const method = parseFunctionDecl(candidate);
            if (!method) {
              return;
            }
            addDeclaration(method.signature.name);
            method.signature.params.forEach((param) => addParameter(param.ast));
          } catch {
            // Parser diagnostics for malformed declarations are handled elsewhere.
          }
        });
      }
    } catch {
      // Parser diagnostics for malformed declarations are handled elsewhere.
    }
  });
};

const collectMacroDeclarationDocsByName = ({
  ast,
  declarationsBySyntaxId,
}: {
  ast: Form;
  declarationsBySyntaxId: ReadonlyMap<number, string>;
}): ReadonlyMap<string, string> => {
  const entries = ast.callsInternal("ast") ? ast.rest : ast.toArray();
  return entries.reduce<Map<string, string>>((docsByName, entry) => {
    if (!isForm(entry)) {
      return docsByName;
    }

    const macroDecl = parseMacroDeclarationName(entry);
    if (!macroDecl) {
      return docsByName;
    }

    const documentation = declarationsBySyntaxId.get(macroDecl.syntax.syntaxId);
    if (!documentation) {
      return docsByName;
    }

    docsByName.set(macroDecl.name, documentation);
    return docsByName;
  }, new Map<string, string>());
};

export const collectModuleDocumentation = ({
  ast,
  source,
  moduleRange,
}: {
  ast: Form;
  source: string;
  moduleRange?: { start: number; end: number };
}): ModuleDocumentationResult => {
  const moduleFilePath = ast.location?.filePath;
  if (!moduleFilePath) {
    return {
      documentation: {
        module: undefined,
        declarationsBySyntaxId: new Map(),
        parametersBySyntaxId: new Map(),
        macroDeclarationsByName: new Map(),
      },
      diagnostics: [],
    };
  }

  const lines = splitSourceLines(source);
  const effectiveModuleRange: IndexRange = {
    start: moduleRange?.start ?? ast.location?.startIndex ?? 0,
    end: moduleRange?.end ?? ast.location?.endIndex ?? source.length,
  };
  const excludedRanges = collectNestedModuleRanges({
    ast,
    moduleFilePath,
  });
  const isExcluded = (lineNumber: number): boolean =>
    excludedRanges.some(
      (range) =>
        lineNumber > range.startLineExclusive &&
        lineNumber <= range.endLineInclusive,
    );

  const declarationTargets = new Map<number, DocTarget[]>();
  const parameterTargets = new Map<number, DocTarget[]>();
  collectDocTargets({
    ast,
    declarationTargets,
    parameterTargets,
    moduleFilePath,
    moduleRange: effectiveModuleRange,
    isExcluded,
  });

  const declarationDocsBySyntaxId = new Map<number, string>();
  const parameterDocsBySyntaxId = new Map<number, string>();
  const diagnostics: Diagnostic[] = [];

  const outerBlocks = buildOuterBlocks({
    lines,
    moduleRange: effectiveModuleRange,
    isExcluded,
  });

  const reportDangling = (block: OuterDocBlock): void => {
    diagnostics.push(
      diagnosticFromCode({
        code: "MD0004",
        params: { kind: "dangling-doc-comment" },
        span: {
          file: moduleFilePath,
          start: block.startIndex,
          end: block.endIndex,
        },
      }),
    );
  };

  outerBlocks.forEach((block) => {
    let sawBlankLine = false;
    let significant: SourceLine | undefined;

    for (let lineNumber = block.endLine + 1; lineNumber <= lines.length; lineNumber += 1) {
      const line = lines[lineNumber - 1];
      if (!line) {
        break;
      }

      if (!inRange(line.startIndex, effectiveModuleRange)) {
        if (line.startIndex >= effectiveModuleRange.end) {
          break;
        }
        continue;
      }

      if (isExcluded(line.lineNumber)) {
        continue;
      }

      if (line.kind === "blank") {
        sawBlankLine = true;
        continue;
      }
      if (line.kind === "regular-comment") {
        continue;
      }
      significant = line;
      break;
    }

    if (!significant || sawBlankLine || significant.kind !== "code") {
      reportDangling(block);
      return;
    }

    const declarationTarget = firstTargetForLine(
      declarationTargets,
      significant.lineNumber,
    );
    if (declarationTarget) {
      if (!declarationDocsBySyntaxId.has(declarationTarget.syntaxId)) {
        declarationDocsBySyntaxId.set(declarationTarget.syntaxId, block.text);
      }
      return;
    }

    const parameterTarget = firstTargetForLine(
      parameterTargets,
      significant.lineNumber,
    );
    if (parameterTarget) {
      if (!parameterDocsBySyntaxId.has(parameterTarget.syntaxId)) {
        parameterDocsBySyntaxId.set(parameterTarget.syntaxId, block.text);
      }
      return;
    }

    reportDangling(block);
  });

  const innerLines = lines.filter(
    (line) =>
      line.kind === "inner-doc" &&
      inRange(line.startIndex, effectiveModuleRange) &&
      !isExcluded(line.lineNumber),
  );
  const moduleDoc =
    innerLines.length > 0
      ? innerLines.map((line) => line.docText ?? "").join("\n")
      : undefined;
  const macroDeclarationsByName = collectMacroDeclarationDocsByName({
    ast,
    declarationsBySyntaxId: declarationDocsBySyntaxId,
  });

  return {
    documentation: {
      module: moduleDoc,
      declarationsBySyntaxId: declarationDocsBySyntaxId,
      parametersBySyntaxId: parameterDocsBySyntaxId,
      macroDeclarationsByName,
    },
    diagnostics,
  };
};
