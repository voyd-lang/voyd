import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  type Form,
  type Syntax,
} from "@voyd/compiler/parser/index.js";
import type { SourceLocation } from "@voyd/compiler/parser/ast/syntax.js";
import type { SourceSpan } from "@voyd/compiler/diagnostics/index.js";
import {
  modulePathFromFile,
  modulePathToString,
} from "@voyd/compiler/modules/path.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type {
  ModuleGraph,
  ModuleRoots,
} from "@voyd/compiler/modules/types.js";
import { createCanonicalSymbolRefResolver } from "@voyd/compiler/semantics/canonical-symbol-ref.js";
import type { SymbolId } from "@voyd/compiler/semantics/ids.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "@voyd/compiler/semantics/binding/parsing.js";
import { collectVoydFiles, toFileUri } from "./files.js";
import { scanExportsFromSource } from "./export-scan.js";
import {
  LineIndex,
  locationRange,
  smallestRangeFirst,
  spanRange,
} from "./text.js";
import type { ExportCandidate, SymbolOccurrence, SymbolRef } from "./types.js";

type SymbolIndex = {
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  declarationsByKey: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
  moduleIdByFilePath: ReadonlyMap<string, string>;
};

const keyForSymbol = ({ moduleId, symbol }: SymbolRef): string => `${moduleId}::${symbol}`;

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

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

export const buildSymbolIndex = async ({
  graph,
  semantics,
  roots,
  sourceByFile,
  lineIndexByFile,
  includeWorkspaceExports = true,
}: {
  graph: ModuleGraph;
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  roots?: ModuleRoots;
  sourceByFile: ReadonlyMap<string, string>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
  includeWorkspaceExports?: boolean;
}): Promise<SymbolIndex> => {
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

  if (includeWorkspaceExports && roots?.src) {
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
          symbol: -1,
          name: exported.name,
          kind: exported.kind,
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
    occurrencesByUri: sortedOccurrences,
    declarationsByKey: sortedDeclarations,
    exportsByName,
    moduleIdByFilePath,
  };
};
