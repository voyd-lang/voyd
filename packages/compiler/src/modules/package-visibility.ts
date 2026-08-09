import { type NormalizedUseEntry } from "../parser/surface/use-path.js";
import { modulePathToString } from "./path.js";
import { resolveModuleRequest } from "./resolve.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import { requireModuleHeader } from "./views.js";

/** Whether a package root publicly exposes an ordinary child module. */
export const isPubliclyExportedOrdinaryModule = ({
  module,
  graph,
}: {
  module: ModuleNode;
  graph: ModuleGraph;
}): boolean =>
  Array.from(graph.modules.values()).some((candidate) => {
    if (!isContainingPackageRoot({ packageRoot: candidate, module })) {
      return false;
    }
    return requireModuleHeader(candidate).items.some(
      (item) =>
        item.kind === "use" &&
        item.visibility === "pub" &&
        item.entries.some(
          (entry) =>
            entry.selectionKind === "module" &&
            resolvesToModule({ packageRoot: candidate, entry, module }),
        ),
    );
  });

const isContainingPackageRoot = ({
  packageRoot,
  module,
}: {
  packageRoot: ModuleNode;
  module: ModuleNode;
}): boolean => {
  if (
    packageRoot.origin.kind !== "file" ||
    packageRoot.path.segments.at(-1) !== "pkg" ||
    packageRoot.path.namespace !== module.path.namespace ||
    packageRoot.path.packageName !== module.path.packageName
  ) {
    return false;
  }
  const packageSegments = packageRoot.path.segments.slice(0, -1);
  return packageSegments.every(
    (segment, index) => module.path.segments[index] === segment,
  );
};

const resolvesToModule = ({
  packageRoot,
  entry,
  module,
}: {
  packageRoot: ModuleNode;
  entry: NormalizedUseEntry;
  module: ModuleNode;
}): boolean =>
  modulePathToString(
    resolveModuleRequest(
      { segments: entry.moduleSegments, span: entry.span },
      packageRoot.path,
      {
        anchorToSelf: entry.anchorToSelf,
        parentHops: entry.parentHops ?? 0,
        importerIsPackageRoot: true,
      },
    ),
  ) === module.id;
