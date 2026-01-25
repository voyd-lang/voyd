import type { TypeId } from "../context.js";

export const getSccContainingRoot = ({
  root,
  getDeps,
}: {
  root: TypeId;
  getDeps: (id: TypeId) => readonly TypeId[];
}): TypeId[] => {
  const adjacency = new Map<TypeId, readonly TypeId[]>();
  const pending: TypeId[] = [root];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (adjacency.has(id)) {
      continue;
    }
    const deps = getDeps(id);
    adjacency.set(id, deps);
    deps.forEach((dep) => {
      if (!adjacency.has(dep)) {
        pending.push(dep);
      }
    });
  }

  const nodes = Array.from(adjacency.keys()).sort((a, b) => a - b);

  const reverseAdj = new Map<TypeId, TypeId[]>();
  nodes.forEach((id) => reverseAdj.set(id, []));
  adjacency.forEach((deps, from) => {
    deps.forEach((to) => {
      const list = reverseAdj.get(to);
      if (list) {
        list.push(from);
      }
    });
  });
  reverseAdj.forEach((list) => list.sort((a, b) => a - b));

  const order: TypeId[] = [];
  const visited = new Set<TypeId>();
  nodes.forEach((start) => {
    if (visited.has(start)) {
      return;
    }
    visited.add(start);
    const stack: { node: TypeId; nextIndex: number }[] = [
      { node: start, nextIndex: 0 },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const deps = adjacency.get(top.node) ?? [];
      if (top.nextIndex < deps.length) {
        const dep = deps[top.nextIndex]!;
        top.nextIndex += 1;
        if (!visited.has(dep)) {
          visited.add(dep);
          stack.push({ node: dep, nextIndex: 0 });
        }
        continue;
      }
      stack.pop();
      order.push(top.node);
    }
  });

  const visitedRev = new Set<TypeId>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const start = order[i]!;
    if (visitedRev.has(start)) {
      continue;
    }
    const component: TypeId[] = [];
    visitedRev.add(start);
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      const incoming = reverseAdj.get(node) ?? [];
      incoming.forEach((pred) => {
        if (!visitedRev.has(pred)) {
          visitedRev.add(pred);
          stack.push(pred);
        }
      });
    }
    if (component.includes(root)) {
      return component.sort((a, b) => a - b);
    }
  }

  return [root];
};

