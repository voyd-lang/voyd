import { existsSync } from "node:fs";
import path from "node:path";
import {
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  type Expr,
} from "@voyd/compiler/parser/index.js";
import type { SourceLocation } from "@voyd/compiler/parser/ast/syntax.js";
import type {
  ModuleGraph,
  ModuleRoots,
} from "@voyd/compiler/modules/types.js";
import type { SymbolId } from "@voyd/compiler/semantics/ids.js";
import type { Range } from "vscode-languageserver/lib/node/main.js";
import { toFileUri } from "./files.js";
import type { LineIndex } from "./text.js";

export const MODULE_SYMBOL_SENTINEL: SymbolId = -1;
export const keyForModule = (moduleId: string): string => `module::${moduleId}`;

type UsePathSegmentWithLocation = {
  value: string;
  location?: SourceLocation;
};

type UsePathLeaf = {
  segments: readonly UsePathSegmentWithLocation[];
};

type ModuleUsePathEntry = {
  moduleId?: string;
  path: readonly string[];
  selectionKind: "all" | "module" | "name";
};

export type ModuleUsePathReference = {
  moduleId: string;
  location: SourceLocation;
};

export type ModuleDeclarationTarget = {
  moduleId: string;
  uri: string;
  range: Range;
  name: string;
};

const collectUsePathLeaves = ({
  expr,
  base = [],
}: {
  expr: Expr | undefined;
  base?: readonly UsePathSegmentWithLocation[];
}): UsePathLeaf[] => {
  if (!expr) {
    return [];
  }

  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return [
      {
        segments: [
          ...base,
          {
            value: expr.value,
            location: expr.location,
          },
        ],
      },
    ];
  }

  if (!isForm(expr)) {
    return [];
  }

  if (expr.calls("::")) {
    const left = collectUsePathLeaves({
      expr: expr.at(1),
      base,
    });
    return left.flatMap((entry) =>
      collectUsePathLeaves({
        expr: expr.at(2),
        base: entry.segments,
      }),
    );
  }

  if (expr.calls("as")) {
    return collectUsePathLeaves({
      expr: expr.at(1),
      base,
    });
  }

  if (expr.callsInternal("object_literal")) {
    return expr.rest.flatMap((entry) =>
      collectUsePathLeaves({
        expr: entry,
        base,
      }),
    );
  }

  return [];
};

const locateNormalizedPathSegments = ({
  path,
  rawSegments,
}: {
  path: readonly string[];
  rawSegments: readonly UsePathSegmentWithLocation[];
}): Array<SourceLocation | undefined> => {
  const locations: Array<SourceLocation | undefined> = [];
  let cursor = 0;

  for (const segment of path) {
    let foundIndex = -1;

    for (let index = cursor; index < rawSegments.length; index += 1) {
      if (rawSegments[index]?.value === segment) {
        foundIndex = index;
        break;
      }
    }

    if (foundIndex < 0) {
      return [];
    }

    locations.push(rawSegments[foundIndex]?.location);
    cursor = foundIndex + 1;
  }

  return locations;
};

export const collectModuleUsePathReferences = ({
  pathExpr,
  entries,
}: {
  pathExpr: Expr | undefined;
  entries: readonly ModuleUsePathEntry[];
}): ModuleUsePathReference[] => {
  const usePathLeaves = collectUsePathLeaves({
    expr: pathExpr,
  });
  if (usePathLeaves.length !== entries.length) {
    return [];
  }

  const references: ModuleUsePathReference[] = [];
  entries.forEach((useEntry, index) => {
    if (!useEntry.moduleId) {
      return;
    }

    const leaf = usePathLeaves[index];
    if (!leaf) {
      return;
    }

    const moduleSegmentCount =
      useEntry.selectionKind === "name"
        ? Math.max(0, useEntry.path.length - 1)
        : useEntry.path.length;
    if (moduleSegmentCount === 0) {
      return;
    }

    const segmentLocations = locateNormalizedPathSegments({
      path: useEntry.path,
      rawSegments: leaf.segments,
    });
    if (segmentLocations.length < moduleSegmentCount) {
      return;
    }

    const resolvedSegments = useEntry.moduleId.split("::");
    if (resolvedSegments.length < moduleSegmentCount) {
      return;
    }

    for (let segmentIndex = 0; segmentIndex < moduleSegmentCount; segmentIndex += 1) {
      const location = segmentLocations[segmentIndex];
      if (!location) {
        continue;
      }

      const prefixLength =
        resolvedSegments.length - (moduleSegmentCount - segmentIndex - 1);
      const targetModuleId = resolvedSegments.slice(0, prefixLength).join("::");
      if (!targetModuleId) {
        continue;
      }
      references.push({
        moduleId: targetModuleId,
        location,
      });
    }
  });

  return references;
};

const moduleNameFromId = (moduleId: string): string =>
  moduleId.split("::").at(-1) ?? moduleId;

const resolveModuleFilePath = ({
  graph,
  roots,
  moduleId,
}: {
  graph: ModuleGraph;
  roots?: ModuleRoots;
  moduleId: string;
}): string | undefined => {
  const moduleNode = graph.modules.get(moduleId);
  if (moduleNode) {
    return path.resolve(
      moduleNode.ast.location?.filePath ??
        (moduleNode.origin.kind === "file" ? moduleNode.origin.filePath : moduleId),
    );
  }

  if (!roots) {
    return undefined;
  }

  const [rootName, ...segments] = moduleId.split("::");
  const rootDir = rootName === "src" ? roots.src : rootName === "std" ? roots.std : undefined;
  if (!rootDir) {
    return undefined;
  }

  const candidateFiles =
    segments.length === 0
      ? [path.resolve(rootDir, "pkg.voyd")]
      : [
          path.resolve(rootDir, `${segments.join(path.sep)}.voyd`),
          path.resolve(rootDir, segments.join(path.sep), "pkg.voyd"),
        ];
  return candidateFiles.find((candidate) => existsSync(candidate));
};

const declarationRangeFor = ({
  graph,
  moduleId,
  lineIndex,
}: {
  graph: ModuleGraph;
  moduleId: string;
  lineIndex: LineIndex | undefined;
}): Range => {
  const moduleLocation = graph.modules.get(moduleId)?.ast.location;
  if (moduleLocation && lineIndex) {
    return lineIndex.range(moduleLocation.startIndex, moduleLocation.startIndex + 1);
  }
  if (lineIndex) {
    return lineIndex.range(0, 1);
  }
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
};

export const createModuleDeclarationResolver = ({
  graph,
  roots,
  lineIndexByFile,
}: {
  graph: ModuleGraph;
  roots?: ModuleRoots;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
}): {
  ensureDeclaration: (moduleId: string) => ModuleDeclarationTarget | undefined;
} => {
  const declarationByModuleId = new Map<string, ModuleDeclarationTarget>();

  const ensureDeclaration = (moduleId: string): ModuleDeclarationTarget | undefined => {
    const cached = declarationByModuleId.get(moduleId);
    if (cached) {
      return cached;
    }

    const filePath = resolveModuleFilePath({ graph, roots, moduleId });
    if (!filePath) {
      return undefined;
    }

    const declaration: ModuleDeclarationTarget = {
      moduleId,
      uri: toFileUri(filePath),
      range: declarationRangeFor({
        graph,
        moduleId,
        lineIndex: lineIndexByFile.get(filePath),
      }),
      name: moduleNameFromId(moduleId),
    };
    declarationByModuleId.set(moduleId, declaration);
    return declaration;
  };

  return {
    ensureDeclaration,
  };
};
