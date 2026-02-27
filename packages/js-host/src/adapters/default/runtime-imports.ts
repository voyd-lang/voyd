import type { NodeFsPromises, NodeReadlinePromises } from "./types.js";

export const maybeNodeFs = async (): Promise<NodeFsPromises | undefined> => {
  const nodeFsSpecifier = ["node", "fs/promises"].join(":");
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const mod = await importModule(nodeFsSpecifier);
    return mod as unknown as NodeFsPromises;
  } catch {
    try {
      const mod = await import(/* @vite-ignore */ nodeFsSpecifier);
      return mod as unknown as NodeFsPromises;
    } catch {
      return undefined;
    }
  }
};

export const maybeNodeReadlinePromises = async (): Promise<
  NodeReadlinePromises | undefined
> => {
  const nodeReadlineSpecifier = ["node", "readline/promises"].join(":");
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const mod = await importModule(nodeReadlineSpecifier);
    return mod as unknown as NodeReadlinePromises;
  } catch {
    try {
      const mod = await import(/* @vite-ignore */ nodeReadlineSpecifier);
      return mod as unknown as NodeReadlinePromises;
    } catch {
      return undefined;
    }
  }
};
