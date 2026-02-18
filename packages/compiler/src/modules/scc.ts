import { modulePathToString } from "./path.js";
import type { ModuleGraph } from "./types.js";

export type ModuleSccGroup = {
  moduleIds: readonly string[];
  cyclic: boolean;
};

export const getModuleSccGroups = ({
  graph,
}: {
  graph: ModuleGraph;
}): ModuleSccGroup[] => {
  const moduleIds = Array.from(graph.modules.keys());
  const moduleIdOrder = new Map(moduleIds.map((id, index) => [id, index]));
  const dependencyIdsByModuleId = buildDependencyIdsByModuleId({
    graph,
    moduleIds,
  });

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexByModuleId = new Map<string, number>();
  const lowlinkByModuleId = new Map<string, number>();
  const groups: string[][] = [];

  const visit = (moduleId: string) => {
    indexByModuleId.set(moduleId, index);
    lowlinkByModuleId.set(moduleId, index);
    index += 1;
    stack.push(moduleId);
    onStack.add(moduleId);

    const dependencyIds = dependencyIdsByModuleId.get(moduleId) ?? [];
    dependencyIds.forEach((dependencyId) => {
      if (!indexByModuleId.has(dependencyId)) {
        visit(dependencyId);
        const moduleLowlink = lowlinkByModuleId.get(moduleId);
        const dependencyLowlink = lowlinkByModuleId.get(dependencyId);
        if (
          typeof moduleLowlink === "number" &&
          typeof dependencyLowlink === "number"
        ) {
          lowlinkByModuleId.set(moduleId, Math.min(moduleLowlink, dependencyLowlink));
        }
        return;
      }

      if (!onStack.has(dependencyId)) {
        return;
      }

      const moduleLowlink = lowlinkByModuleId.get(moduleId);
      const dependencyIndex = indexByModuleId.get(dependencyId);
      if (typeof moduleLowlink === "number" && typeof dependencyIndex === "number") {
        lowlinkByModuleId.set(moduleId, Math.min(moduleLowlink, dependencyIndex));
      }
    });

    if (lowlinkByModuleId.get(moduleId) !== indexByModuleId.get(moduleId)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const id = stack.pop()!;
      onStack.delete(id);
      component.push(id);
      if (id === moduleId) {
        break;
      }
    }

    component.sort(
      (left, right) => (moduleIdOrder.get(left) ?? 0) - (moduleIdOrder.get(right) ?? 0),
    );
    groups.push(component);
  };

  moduleIds.forEach((moduleId) => {
    if (indexByModuleId.has(moduleId)) {
      return;
    }
    visit(moduleId);
  });

  return groups.map((group) => ({
    moduleIds: group,
    cyclic: isCyclicGroup({ group, dependencyIdsByModuleId }),
  }));
};

const buildDependencyIdsByModuleId = ({
  graph,
  moduleIds,
}: {
  graph: ModuleGraph;
  moduleIds: readonly string[];
}): ReadonlyMap<string, readonly string[]> =>
  new Map(
    moduleIds.map((moduleId) => {
      const module = graph.modules.get(moduleId);
      const dependencyIds = new Set(
        (module?.dependencies ?? [])
          .map((dependency) => modulePathToString(dependency.path))
          .filter((dependencyId) => graph.modules.has(dependencyId)),
      );
      return [moduleId, Array.from(dependencyIds)] as const;
    }),
  );

const isCyclicGroup = ({
  group,
  dependencyIdsByModuleId,
}: {
  group: readonly string[];
  dependencyIdsByModuleId: ReadonlyMap<string, readonly string[]>;
}): boolean => {
  if (group.length > 1) {
    return true;
  }
  const moduleId = group[0];
  if (!moduleId) {
    return false;
  }
  return (dependencyIdsByModuleId.get(moduleId) ?? []).includes(moduleId);
};
