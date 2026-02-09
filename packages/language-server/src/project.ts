import path, { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { access, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  type Form,
  type Syntax,
} from "@voyd/compiler/parser/index.js";
import type { SourceLocation } from "@voyd/compiler/parser/ast/syntax.js";
import type {
  Diagnostic as CompilerDiagnostic,
  SourceSpan,
} from "@voyd/compiler/diagnostics/index.js";
import { buildModuleGraph } from "@voyd/compiler/modules/graph.js";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type {
  ModuleGraph,
  ModuleHost,
  ModuleRoots,
} from "@voyd/compiler/modules/types.js";
import { modulePathFromFile, modulePathToString } from "@voyd/compiler/modules/path.js";
import { analyzeModules } from "@voyd/compiler/pipeline-shared.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import type { SymbolId } from "@voyd/compiler/semantics/ids.js";
import { createCanonicalSymbolRefResolver } from "@voyd/compiler/semantics/canonical-symbol-ref.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "@voyd/compiler/semantics/binding/parsing.js";
import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  type Location,
  type Position,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver/lib/node/main.js";
import { URI } from "vscode-uri";

const require = createRequire(import.meta.url);

const resolveStdRoot = (): string => {
  const packageJsonPath = require.resolve("@voyd/std/package.json");
  const packageRoot = dirname(packageJsonPath);
  const srcRoot = join(packageRoot, "src");
  return existsSync(srcRoot) ? srcRoot : packageRoot;
};

export type SymbolOccurrence = {
  canonicalKey: string;
  moduleId: string;
  symbol: SymbolId;
  uri: string;
  range: Range;
  name: string;
  kind: "declaration" | "reference";
};

type SymbolRef = { moduleId: string; symbol: SymbolId };

type ExportCandidate = {
  moduleId: string;
  symbol: SymbolId;
  name: string;
  kind: string;
};

type ExportKind = "value" | "type" | "trait" | "effect";

type AnalysisInputs = {
  entryPath: string;
  roots: ModuleRoots;
  openDocuments: ReadonlyMap<string, string>;
};

export type ProjectAnalysis = {
  diagnosticsByUri: ReadonlyMap<string, Diagnostic[]>;
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  declarationsByKey: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
  moduleIdByFilePath: ReadonlyMap<string, string>;
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
};

const fsExists = async (targetPath: string): Promise<boolean> =>
  access(targetPath)
    .then(() => true)
    .catch(() => false);

const collectNodeModulesDirs = (startDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    dirs.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
};

const collectVoydFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectVoydFiles(fullPath);
      }
      return fullPath.endsWith(".voyd") ? [fullPath] : [];
    }),
  );
  return nested.flat();
};

const dedupe = <T>(values: readonly T[]): T[] => Array.from(new Set(values));

const normalizeFilePath = (filePath: string): string => path.resolve(filePath);

export const toFileUri = (filePath: string): string =>
  URI.file(path.resolve(filePath)).toString();

const toFilePath = (uri: string): string => URI.parse(uri).fsPath;

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const resolveEntryPath = async (filePath: string): Promise<string> => {
  const resolvedFile = path.resolve(filePath);
  let current = path.dirname(resolvedFile);

  while (true) {
    const pkgEntry = path.join(current, "pkg.voyd");
    if (await fsExists(pkgEntry)) {
      return pkgEntry;
    }

    const mainEntry = path.join(current, "main.voyd");
    if (await fsExists(mainEntry)) {
      return mainEntry;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolvedFile;
    }
    current = parent;
  }
};

export const resolveModuleRoots = (entryPath: string): ModuleRoots => {
  const src = path.dirname(entryPath);
  return {
    src,
    std: resolveStdRoot(),
    pkgDirs: dedupe(collectNodeModulesDirs(src)),
  };
};

const createOverlayModuleHost = ({
  openDocuments,
}: {
  openDocuments: ReadonlyMap<string, string>;
}): ModuleHost => {
  const primary = createMemoryModuleHost({
    files: Object.fromEntries(openDocuments.entries()),
    pathAdapter: createNodePathAdapter(),
  });
  const fallback = createFsModuleHost();

  return {
    path: primary.path,
    readFile: async (filePath: string) =>
      (await primary.fileExists(filePath))
        ? primary.readFile(filePath)
        : fallback.readFile(filePath),
    readDir: async (dirPath: string) => {
      const [primaryDir, fallbackDir] = await Promise.all([
        primary.isDirectory(dirPath),
        fallback.isDirectory(dirPath),
      ]);

      if (!primaryDir && !fallbackDir) {
        return [];
      }

      const [primaryEntries, fallbackEntries] = await Promise.all([
        primaryDir ? primary.readDir(dirPath) : Promise.resolve([]),
        fallbackDir ? fallback.readDir(dirPath) : Promise.resolve([]),
      ]);

      return dedupe([...primaryEntries, ...fallbackEntries]);
    },
    fileExists: async (filePath: string) =>
      (await primary.fileExists(filePath)) || fallback.fileExists(filePath),
    isDirectory: async (dirPath: string) =>
      (await primary.isDirectory(dirPath)) || fallback.isDirectory(dirPath),
  };
};

class LineIndex {
  readonly #starts: number[];

  constructor(private readonly text: string) {
    this.#starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") {
        this.#starts.push(index + 1);
      }
    }
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.#starts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const lineStart = this.#starts[mid]!;
      const nextLineStart =
        mid + 1 < this.#starts.length ? this.#starts[mid + 1]! : this.text.length + 1;

      if (clamped < lineStart) {
        high = mid - 1;
        continue;
      }

      if (clamped >= nextLineStart) {
        low = mid + 1;
        continue;
      }

      return { line: mid, character: clamped - lineStart };
    }

    const line = Math.max(0, this.#starts.length - 1);
    return { line, character: clamped - this.#starts[line]! };
  }

  range(start: number, end: number): Range {
    const clampedStart = Math.max(0, Math.min(start, this.text.length));
    const clampedEnd = Math.max(clampedStart + 1, Math.min(end, this.text.length));

    return {
      start: this.positionAt(clampedStart),
      end: this.positionAt(clampedEnd),
    };
  }
}

const collectSyntaxById = (root: Form): Map<number, Syntax> => {
  const syntaxById = new Map<number, Syntax>();

  const visit = (syntax: Syntax | undefined): void => {
    if (!syntax || syntaxById.has(syntax.syntaxId)) {
      return;
    }

    syntaxById.set(syntax.syntaxId, syntax);

    if (!isForm(syntax)) {
      return;
    }

    syntax.toArray().forEach((entry) => visit(entry));
  };

  visit(root);
  return syntaxById;
};

const locationRange = ({
  location,
  lineIndex,
}: {
  location: SourceLocation | undefined;
  lineIndex: LineIndex | undefined;
}): Range | undefined => {
  if (!location || !lineIndex) {
    return undefined;
  }

  return lineIndex.range(location.startIndex, location.endIndex);
};

const spanRange = ({
  span,
  lineIndex,
}: {
  span: SourceSpan;
  lineIndex: LineIndex | undefined;
}): Range | undefined => {
  if (!lineIndex) {
    return undefined;
  }
  return lineIndex.range(span.start, span.end);
};

const keyForSymbol = ({ moduleId, symbol }: SymbolRef): string => `${moduleId}::${symbol}`;

const pushOccurrence = ({
  occurrence,
  byUri,
  byKey,
  dedupeKeys,
}: {
  occurrence: SymbolOccurrence;
  byUri: Map<string, SymbolOccurrence[]>;
  byKey: Map<string, SymbolOccurrence[]>;
  dedupeKeys: Set<string>;
}): void => {
  const dedupeKey = `${occurrence.kind}:${occurrence.moduleId}:${occurrence.symbol}:${occurrence.uri}:${occurrence.range.start.line}:${occurrence.range.start.character}:${occurrence.range.end.line}:${occurrence.range.end.character}`;
  if (dedupeKeys.has(dedupeKey)) {
    return;
  }
  dedupeKeys.add(dedupeKey);

  const forUri = byUri.get(occurrence.uri) ?? [];
  forUri.push(occurrence);
  byUri.set(occurrence.uri, forUri);

  const forKey = byKey.get(occurrence.canonicalKey) ?? [];
  forKey.push(occurrence);
  byKey.set(occurrence.canonicalKey, forKey);
};

const isInRange = (position: Position, range: Range): boolean => {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }

  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }

  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }

  return true;
};

const smallestRangeFirst = (left: SymbolOccurrence, right: SymbolOccurrence): number => {
  const leftWidth =
    (left.range.end.line - left.range.start.line) * 10000 +
    (left.range.end.character - left.range.start.character);
  const rightWidth =
    (right.range.end.line - right.range.start.line) * 10000 +
    (right.range.end.character - right.range.start.character);

  return leftWidth - rightWidth;
};

const resolveFunctionNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const parsed = parseFunctionDecl(form);
  return parsed?.signature.name;
};

const resolveTypeAliasNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const parsed = parseTypeAliasDecl(form);
  return parsed?.name;
};

const resolveObjectNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const parsed = parseObjectDecl(form);
  return parsed?.name;
};

const resolveTraitNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const parsed = parseTraitDecl(form);
  return parsed?.name;
};

const resolveEffectNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const parsed = parseEffectDecl(form);
  return parsed?.name;
};

const resolveEffectOperationNameSyntax = (form: Form | undefined): Syntax | undefined => {
  if (!form) {
    return undefined;
  }

  const signature = form.calls("fn") ? form.at(1) : form;
  if (isIdentifierAtom(signature) || isInternalIdentifierAtom(signature)) {
    return signature;
  }

  if (!isForm(signature)) {
    return undefined;
  }

  if (signature.calls("->")) {
    const candidate = signature.at(1);
    if (isIdentifierAtom(candidate) || isInternalIdentifierAtom(candidate)) {
      return candidate;
    }
    if (isForm(candidate)) {
      const head = candidate.at(0);
      if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
        return head;
      }
    }
  }

  const head = signature.at(0);
  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    return head;
  }

  return undefined;
};

const findMethodNameSyntax = ({
  callForm,
  methodName,
}: {
  callForm: Form;
  methodName: string;
}): Syntax | undefined => {
  const methodFromMember = (member: unknown): Syntax | undefined => {
    if (isIdentifierAtom(member) || isInternalIdentifierAtom(member)) {
      return member.value === methodName ? member : undefined;
    }

    if (!isForm(member)) {
      return undefined;
    }

    const head = member.at(0);
    if ((isIdentifierAtom(head) || isInternalIdentifierAtom(head)) && head.value === methodName) {
      return head;
    }

    return undefined;
  };

  if (callForm.calls(".")) {
    return methodFromMember(callForm.at(2));
  }

  if (!callForm.calls("::")) {
    return undefined;
  }

  const member = callForm.at(2);
  if (isForm(member) && member.calls("::")) {
    return methodFromMember(member.at(2));
  }

  return methodFromMember(member);
};

const diagnosticSeverity = (severity: CompilerDiagnostic["severity"]): DiagnosticSeverity => {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    default:
      return DiagnosticSeverity.Information;
  }
};

const extractMissingSymbolName = (diagnostic: Diagnostic): string | undefined => {
  const match = /'([^']+)'/.exec(diagnostic.message);
  return match?.[1];
};

const supportsAutoImport = (code: string): boolean =>
  code === "TY0006" || code === "TY0026" || code === "TY0030";

const kindMatchesDiagnostic = ({ code, kind }: { code: string; kind: string }): boolean => {
  if (code === "TY0026") {
    return kind === "type" || kind === "trait";
  }

  if (code === "TY0006") {
    return kind === "value";
  }

  return kind !== "module";
};

const exportRegexByKind: Record<ExportKind, RegExp> = {
  value: /(?:^|\n)\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_']*)/g,
  type: /(?:^|\n)\s*pub\s+(?:type|obj)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  trait: /(?:^|\n)\s*pub\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  effect: /(?:^|\n)\s*pub\s+eff\s+([A-Za-z_][A-Za-z0-9_]*)/g,
};

const scanExportsFromSource = (source: string): ExportCandidate[] => {
  const exports: ExportCandidate[] = [];

  (Object.entries(exportRegexByKind) as Array<[ExportKind, RegExp]>).forEach(
    ([kind, regex]) => {
      regex.lastIndex = 0;
      let match = regex.exec(source);
      while (match) {
        const name = match[1];
        if (name) {
          exports.push({
            moduleId: "",
            symbol: -1,
            name,
            kind,
          });
        }
        match = regex.exec(source);
      }
    },
  );

  return exports;
};

export const analyzeProject = async ({
  entryPath,
  roots,
  openDocuments,
}: AnalysisInputs): Promise<ProjectAnalysis> => {
  const normalizedOpenDocuments = new Map<string, string>(
    Array.from(openDocuments.entries()).map(([filePath, text]) => [
      normalizeFilePath(filePath),
      text,
    ]),
  );

  const host = createOverlayModuleHost({ openDocuments: normalizedOpenDocuments });
  const graph = await buildModuleGraph({
    entryPath: path.resolve(entryPath),
    roots,
    host,
  });

  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  const sourceByFile = new Map<string, string>();
  normalizedOpenDocuments.forEach((source, filePath) => sourceByFile.set(filePath, source));
  graph.modules.forEach((moduleNode) => {
    if (moduleNode.origin.kind === "file") {
      sourceByFile.set(path.resolve(moduleNode.origin.filePath), moduleNode.source);
    }
  });

  const lineIndexByFile = new Map<string, LineIndex>(
    Array.from(sourceByFile.entries()).map(([filePath, source]) => [
      filePath,
      new LineIndex(source),
    ]),
  );

  const diagnosticsByUri = new Map<string, Diagnostic[]>();
  diagnostics.forEach((diagnostic) => {
    const filePath = path.resolve(diagnostic.span.file);
    const lineIndex = lineIndexByFile.get(filePath);
    const range = spanRange({ span: diagnostic.span, lineIndex });
    if (!range) {
      return;
    }

    const uri = toFileUri(filePath);
    const existing = diagnosticsByUri.get(uri) ?? [];
    existing.push({
      range,
      code: diagnostic.code,
      source: "voyd",
      message: diagnostic.message,
      severity: diagnosticSeverity(diagnostic.severity),
    });
    diagnosticsByUri.set(uri, existing);
  });

  const resolveImportTarget = (ref: SymbolRef): SymbolRef | undefined => {
    const module = semantics.get(ref.moduleId);
    if (!module) {
      return undefined;
    }

    const target = module.binding.imports.find((entry) => entry.local === ref.symbol)?.target;
    if (!target) {
      return undefined;
    }

    return { moduleId: target.moduleId, symbol: target.symbol };
  };

  const canonicalize = createCanonicalSymbolRefResolver({ resolveImportTarget });

  const symbolNameFor = (ref: SymbolRef): string => {
    const module = semantics.get(ref.moduleId);
    if (!module) {
      return `${ref.symbol}`;
    }
    return module.binding.symbolTable.getSymbol(ref.symbol).name;
  };

  const occurrencesByUri = new Map<string, SymbolOccurrence[]>();
  const occurrencesByKey = new Map<string, SymbolOccurrence[]>();
  const dedupeKeys = new Set<string>();

  const addOccurrenceFromLocation = ({
    symbolRef,
    location,
    kind,
  }: {
    symbolRef: SymbolRef;
    location: SourceLocation | undefined;
    kind: SymbolOccurrence["kind"];
  }): void => {
    if (!location) {
      return;
    }

    const filePath = path.resolve(location.filePath);
    const lineIndex = lineIndexByFile.get(filePath);
    const range = locationRange({ location, lineIndex });
    if (!range) {
      return;
    }

    const canonical = canonicalize(symbolRef);
    pushOccurrence({
      occurrence: {
        canonicalKey: keyForSymbol(canonical),
        moduleId: symbolRef.moduleId,
        symbol: symbolRef.symbol,
        uri: toFileUri(filePath),
        range,
        name: symbolNameFor(symbolRef),
        kind,
      },
      byUri: occurrencesByUri,
      byKey: occurrencesByKey,
      dedupeKeys,
    });
  };

  const addOccurrenceFromSpan = ({
    symbolRef,
    span,
    kind,
  }: {
    symbolRef: SymbolRef;
    span: SourceSpan;
    kind: SymbolOccurrence["kind"];
  }): void => {
    const filePath = path.resolve(span.file);
    const lineIndex = lineIndexByFile.get(filePath);
    const range = spanRange({ span, lineIndex });
    if (!range) {
      return;
    }

    const canonical = canonicalize(symbolRef);
    pushOccurrence({
      occurrence: {
        canonicalKey: keyForSymbol(canonical),
        moduleId: symbolRef.moduleId,
        symbol: symbolRef.symbol,
        uri: toFileUri(filePath),
        range,
        name: symbolNameFor(symbolRef),
        kind,
      },
      byUri: occurrencesByUri,
      byKey: occurrencesByKey,
      dedupeKeys,
    });
  };

  const addOccurrenceFromImportSpan = ({
    symbolRef,
    span,
    localName,
  }: {
    symbolRef: SymbolRef;
    span: SourceSpan;
    localName: string;
  }): void => {
    const filePath = path.resolve(span.file);
    const source = sourceByFile.get(filePath);
    const lineIndex = lineIndexByFile.get(filePath);
    if (!source || !lineIndex) {
      return;
    }

    const start = Math.max(0, Math.min(span.start, source.length));
    const end = Math.max(start, Math.min(span.end, source.length));
    const snippet = source.slice(start, end);
    if (snippet.length === 0) {
      return;
    }

    const matcher = new RegExp(`\\b${escapeForRegex(localName)}\\b`, "g");
    let match = matcher.exec(snippet);
    let selected: RegExpExecArray | null = null;
    while (match) {
      selected = match;
      match = matcher.exec(snippet);
    }

    const range = selected
      ? lineIndex.range(start + selected.index, start + selected.index + localName.length)
      : spanRange({ span, lineIndex });
    if (!range) {
      return;
    }

    const canonical = canonicalize(symbolRef);
    pushOccurrence({
      occurrence: {
        canonicalKey: keyForSymbol(canonical),
        moduleId: symbolRef.moduleId,
        symbol: symbolRef.symbol,
        uri: toFileUri(filePath),
        range,
        name: symbolNameFor(symbolRef),
        kind: "reference",
      },
      byUri: occurrencesByUri,
      byKey: occurrencesByKey,
      dedupeKeys,
    });
  };

  const moduleIdByFilePath = new Map<string, string>();
  const exportsByName = new Map<string, ExportCandidate[]>();
  const exportDedup = new Set<string>();

  graph.modules.forEach((moduleNode, moduleId) => {
    const filePath = path.resolve(
      moduleNode.ast.location?.filePath ??
        (moduleNode.origin.kind === "file" ? moduleNode.origin.filePath : moduleId),
    );
    moduleIdByFilePath.set(filePath, moduleId);
  });

  semantics.forEach((entry, moduleId) => {
    const moduleNode = graph.modules.get(moduleId);
    if (!moduleNode) {
      return;
    }
    const syntaxById = collectSyntaxById(moduleNode.ast);

    const moduleRef = (symbol: SymbolId): SymbolRef => ({ moduleId, symbol });

    entry.binding.imports.forEach((imported) => {
      if (!imported.target || !imported.span) {
        return;
      }

      addOccurrenceFromImportSpan({
        symbolRef: moduleRef(imported.local),
        span: imported.span,
        localName: imported.name,
      });
    });

    entry.binding.functions.forEach((fn) => {
      addOccurrenceFromLocation({
        symbolRef: moduleRef(fn.symbol),
        location: resolveFunctionNameSyntax(fn.form)?.location,
        kind: "declaration",
      });

      fn.params.forEach((param) => {
        addOccurrenceFromLocation({
          symbolRef: moduleRef(param.symbol),
          location: param.ast?.location,
          kind: "declaration",
        });
      });
    });

    entry.binding.typeAliases.forEach((alias) => {
      addOccurrenceFromLocation({
        symbolRef: moduleRef(alias.symbol),
        location: resolveTypeAliasNameSyntax(alias.form)?.location,
        kind: "declaration",
      });
    });

    entry.binding.objects.forEach((object) => {
      addOccurrenceFromLocation({
        symbolRef: moduleRef(object.symbol),
        location: resolveObjectNameSyntax(object.form)?.location,
        kind: "declaration",
      });
    });

    entry.binding.traits.forEach((trait) => {
      addOccurrenceFromLocation({
        symbolRef: moduleRef(trait.symbol),
        location: resolveTraitNameSyntax(trait.form)?.location,
        kind: "declaration",
      });

      trait.methods.forEach((method) => {
        addOccurrenceFromLocation({
          symbolRef: moduleRef(method.symbol),
          location: method.nameAst?.location,
          kind: "declaration",
        });

        method.params.forEach((param) => {
          addOccurrenceFromLocation({
            symbolRef: moduleRef(param.symbol),
            location: param.ast?.location,
            kind: "declaration",
          });
        });
      });
    });

    entry.binding.effects.forEach((effect) => {
      addOccurrenceFromLocation({
        symbolRef: moduleRef(effect.symbol),
        location: resolveEffectNameSyntax(effect.form)?.location,
        kind: "declaration",
      });

      effect.operations.forEach((operation) => {
        addOccurrenceFromLocation({
          symbolRef: moduleRef(operation.symbol),
          location: resolveEffectOperationNameSyntax(operation.ast as Form | undefined)?.location,
          kind: "declaration",
        });

        operation.parameters.forEach((param) => {
          addOccurrenceFromLocation({
            symbolRef: moduleRef(param.symbol),
            location: param.ast?.location,
            kind: "declaration",
          });
        });
      });
    });

    entry.hir.statements.forEach((statement) => {
      if (statement.kind === "let") {
        collectPatternSymbols(statement.pattern).forEach(({ symbol, span }) => {
          addOccurrenceFromSpan({
            symbolRef: moduleRef(symbol),
            span,
            kind: "declaration",
          });
        });
      }
    });

    entry.hir.items.forEach((item) => {
      if (item.kind === "function") {
        item.parameters.forEach((parameter) => {
          collectPatternSymbols(parameter.pattern).forEach(({ symbol, span }) => {
            addOccurrenceFromSpan({
              symbolRef: moduleRef(symbol),
              span,
              kind: "declaration",
            });
          });
        });
      }
    });

    entry.hir.expressions.forEach((expression) => {
      if (expression.exprKind === "identifier") {
        addOccurrenceFromSpan({
          symbolRef: moduleRef(expression.symbol),
          span: expression.span,
          kind: "reference",
        });
      }

      if (expression.exprKind === "lambda") {
        expression.parameters.forEach((parameter) => {
          collectPatternSymbols(parameter.pattern).forEach(({ symbol, span }) => {
            addOccurrenceFromSpan({
              symbolRef: moduleRef(symbol),
              span,
              kind: "declaration",
            });
          });
        });
      }

      if (expression.exprKind === "match") {
        expression.arms.forEach((arm) => {
          collectPatternSymbols(arm.pattern).forEach(({ symbol, span }) => {
            addOccurrenceFromSpan({
              symbolRef: moduleRef(symbol),
              span,
              kind: "declaration",
            });
          });
        });
      }

      if (expression.exprKind === "assign" && expression.pattern) {
        collectPatternSymbols(expression.pattern).forEach(({ symbol, span }) => {
          addOccurrenceFromSpan({
            symbolRef: moduleRef(symbol),
            span,
            kind: "declaration",
          });
        });
      }

      if (expression.exprKind === "method-call") {
        const methodTarget = entry.typing.callTargets.get(expression.id);
        const selected = methodTarget ? Array.from(methodTarget.values())[0] : undefined;
        if (selected) {
          const methodSyntax = syntaxById.get(expression.ast);
          const methodNameSyntax =
            methodSyntax && isForm(methodSyntax)
              ? findMethodNameSyntax({
                  callForm: methodSyntax,
                  methodName: expression.method,
                })
              : undefined;

          if (methodNameSyntax?.location) {
            addOccurrenceFromLocation({
              symbolRef: {
                moduleId: selected.moduleId,
                symbol: selected.symbol,
              },
              location: methodNameSyntax.location,
              kind: "reference",
            });
          }
        }
      }

      collectNamedTypeReferences(expression).forEach(({ symbol, span }) => {
        addOccurrenceFromSpan({
          symbolRef: moduleRef(symbol),
          span,
          kind: "reference",
        });
      });
    });

    entry.hir.items.forEach((item) => {
      collectNamedTypeReferences(item).forEach(({ symbol, span }) => {
        addOccurrenceFromSpan({
          symbolRef: moduleRef(symbol),
          span,
          kind: "reference",
        });
      });
    });

    entry.exports.forEach((exported) => {
      const dedupeKey = `${moduleId}:${exported.name}:${exported.kind}:${exported.symbol}`;
      if (exportDedup.has(dedupeKey)) {
        return;
      }
      exportDedup.add(dedupeKey);
      const existing = exportsByName.get(exported.name) ?? [];
      existing.push({
        moduleId,
        symbol: exported.symbol,
        name: exported.name,
        kind: exported.kind,
      });
      exportsByName.set(exported.name, existing);
    });
  });

  if (roots.src) {
    const sourceFiles = await collectVoydFiles(path.resolve(roots.src));
    for (const filePath of sourceFiles) {
      const normalized = path.resolve(filePath);
      const source =
        sourceByFile.get(normalized) ??
        (await readFile(normalized, "utf8").catch(() => undefined));
      if (!source) {
        continue;
      }
      const moduleId = modulePathToString(
        modulePathFromFile(normalized, roots, createNodePathAdapter()),
      );
      scanExportsFromSource(source).forEach((exported) => {
        const dedupeKey = `${moduleId}:${exported.name}:${exported.kind}`;
        if (exportDedup.has(dedupeKey)) {
          return;
        }
        exportDedup.add(dedupeKey);
        const existing = exportsByName.get(exported.name) ?? [];
        existing.push({
          ...exported,
          moduleId,
        });
        exportsByName.set(exported.name, existing);
      });
    }
  }

  const declarationsByKey = new Map<string, SymbolOccurrence[]>(
    Array.from(occurrencesByKey.entries()).map(([key, entries]) => [
      key,
      entries.filter((entry) => entry.kind === "declaration"),
    ]),
  );

  const sortedOccurrences = new Map<string, SymbolOccurrence[]>(
    Array.from(occurrencesByUri.entries()).map(([uri, entries]) => [
      uri,
      entries.sort(smallestRangeFirst),
    ]),
  );

  const sortedDeclarations = new Map<string, SymbolOccurrence[]>(
    Array.from(declarationsByKey.entries()).map(([key, entries]) => [
      key,
      entries.sort(smallestRangeFirst),
    ]),
  );

  return {
    diagnosticsByUri,
    occurrencesByUri: sortedOccurrences,
    declarationsByKey: sortedDeclarations,
    exportsByName,
    moduleIdByFilePath,
    graph,
    semantics,
  };
};

const collectPatternSymbols = (
  pattern: unknown,
): Array<{ symbol: SymbolId; span: SourceSpan }> => {
  if (!pattern || typeof pattern !== "object") {
    return [];
  }

  const typed = pattern as {
    kind?: string;
    symbol?: number;
    span?: SourceSpan;
    fields?: Array<{ pattern?: unknown }>;
    spread?: unknown;
    elements?: unknown[];
    binding?: unknown;
  };

  if (typed.kind === "identifier" && typeof typed.symbol === "number" && typed.span) {
    return [{ symbol: typed.symbol, span: typed.span }];
  }

  if (typed.kind === "destructure") {
    const fromFields = (typed.fields ?? []).flatMap((field) =>
      collectPatternSymbols(field.pattern),
    );
    const fromSpread = collectPatternSymbols(typed.spread);
    return [...fromFields, ...fromSpread];
  }

  if (typed.kind === "tuple") {
    return (typed.elements ?? []).flatMap((entry) => collectPatternSymbols(entry));
  }

  if (typed.kind === "type") {
    return collectPatternSymbols(typed.binding);
  }

  return [];
};

const isSourceSpan = (value: unknown): value is SourceSpan => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const span = value as SourceSpan;
  return (
    typeof span.file === "string" &&
    typeof span.start === "number" &&
    typeof span.end === "number"
  );
};

const collectNamedTypeReferences = (
  value: unknown,
): Array<{ symbol: SymbolId; span: SourceSpan }> => {
  const results: Array<{ symbol: SymbolId; span: SourceSpan }> = [];

  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item));
      return;
    }

    const candidate = entry as {
      typeKind?: unknown;
      symbol?: unknown;
      span?: unknown;
    };

    if (
      candidate.typeKind === "named" &&
      typeof candidate.symbol === "number" &&
      isSourceSpan(candidate.span)
    ) {
      results.push({ symbol: candidate.symbol, span: candidate.span });
    }

    Object.values(entry).forEach((item) => visit(item));
  };

  visit(value);
  return results;
};

const findSymbolAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: ProjectAnalysis;
  uri: string;
  position: Position;
}): SymbolOccurrence | undefined => {
  const occurrences = analysis.occurrencesByUri.get(uri);
  if (!occurrences || occurrences.length === 0) {
    return undefined;
  }

  return occurrences.find((entry) => isInRange(position, entry.range));
};

export const definitionsAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: ProjectAnalysis;
  uri: string;
  position: Position;
}): Location[] => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol) {
    return [];
  }

  const declarations = analysis.declarationsByKey.get(symbol.canonicalKey) ?? [];
  return declarations.map((entry) => ({
    uri: entry.uri,
    range: entry.range,
  }));
};

export const prepareRenameAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: ProjectAnalysis;
  uri: string;
  position: Position;
}): { range: Range; placeholder: string } | null => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol) {
    return null;
  }

  return { range: symbol.range, placeholder: symbol.name };
};

export const renameAtPosition = ({
  analysis,
  uri,
  position,
  newName,
}: {
  analysis: ProjectAnalysis;
  uri: string;
  position: Position;
  newName: string;
}): WorkspaceEdit | null => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol) {
    return null;
  }

  const editsByUri = new Map<string, TextEdit[]>();
  const allOccurrences =
    analysis.occurrencesByUri.get(uri)?.filter((entry) => entry.canonicalKey === symbol.canonicalKey) ??
    [];

  Array.from(analysis.occurrencesByUri.values())
    .flat()
    .filter((entry) => entry.canonicalKey === symbol.canonicalKey)
    .forEach((entry) => {
      const edits = editsByUri.get(entry.uri) ?? [];
      edits.push({ range: entry.range, newText: newName });
      editsByUri.set(entry.uri, edits);
    });

  if (allOccurrences.length === 0 && editsByUri.size === 0) {
    return null;
  }

  return {
    changes: Object.fromEntries(editsByUri.entries()),
  };
};

const insertImportEdit = ({
  analysis,
  documentUri,
  importLine,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  importLine: string;
}): TextEdit | undefined => {
  const filePath = path.resolve(toFilePath(documentUri));
  const moduleId = analysis.moduleIdByFilePath.get(filePath);
  if (!moduleId) {
    return undefined;
  }

  const semantics = analysis.semantics.get(moduleId);
  const moduleNode = analysis.graph.modules.get(moduleId);
  const source = moduleNode?.source;
  if (!source) {
    return undefined;
  }

  const lineIndex = new LineIndex(source);
  const useEndOffsets = semantics
    ? semantics.binding.uses
        .map((useDecl) => useDecl.form.location?.endIndex)
        .filter((offset): offset is number => typeof offset === "number")
    : [];

  const insertionOffset = useEndOffsets.length > 0 ? Math.max(...useEndOffsets) : 0;
  const insertionRange = {
    start: lineIndex.positionAt(insertionOffset),
    end: lineIndex.positionAt(insertionOffset),
  };

  const prefix = insertionOffset > 0 ? "\n" : "";
  const suffix = insertionOffset > 0 ? "" : "\n";

  return {
    range: insertionRange,
    newText: `${prefix}${importLine}${suffix}`,
  };
};

const importActionsForDiagnostic = ({
  analysis,
  documentUri,
  diagnostic,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  diagnostic: Diagnostic;
}): CodeAction[] => {
  const code = typeof diagnostic.code === "string" ? diagnostic.code : undefined;
  if (!code || !supportsAutoImport(code)) {
    return [];
  }

  const missingName = extractMissingSymbolName(diagnostic);
  if (!missingName) {
    return [];
  }

  const currentFilePath = path.resolve(toFilePath(documentUri));
  const currentModuleId = analysis.moduleIdByFilePath.get(currentFilePath);

  const candidates = (analysis.exportsByName.get(missingName) ?? [])
    .filter((candidate) => candidate.moduleId !== currentModuleId)
    .filter((candidate) => kindMatchesDiagnostic({ code, kind: candidate.kind }));

  const seenImportLines = new Set<string>();

  return candidates
    .map((candidate) => {
      const importLine = `use ${candidate.moduleId}::${candidate.name}`;
      if (seenImportLines.has(importLine)) {
        return undefined;
      }
      seenImportLines.add(importLine);

      const edit = insertImportEdit({
        analysis,
        documentUri,
        importLine,
      });
      if (!edit) {
        return undefined;
      }

      return CodeAction.create(
        `Import ${candidate.name} from ${candidate.moduleId}`,
        {
          changes: {
            [documentUri]: [edit],
          },
        },
        CodeActionKind.QuickFix,
      );
    })
    .filter((action): action is CodeAction => Boolean(action));
};

export const autoImportActions = ({
  analysis,
  documentUri,
  diagnostics,
}: {
  analysis: ProjectAnalysis;
  documentUri: string;
  diagnostics: readonly Diagnostic[];
}): CodeAction[] =>
  diagnostics.flatMap((diagnostic) =>
    importActionsForDiagnostic({
      analysis,
      documentUri,
      diagnostic,
    }),
  );
