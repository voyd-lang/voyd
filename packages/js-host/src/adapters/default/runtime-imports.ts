import type { NodeFsPromises, NodeReadlinePromises } from "./types.js";

export type NodeHttpIncomingMessage = AsyncIterable<unknown> & {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
};

export type NodeHttpServerResponse = {
  destroyed: boolean;
  writableEnded: boolean;
  statusCode: number;
  statusMessage: string;
  setHeader: (name: string, value: string | string[]) => void;
  once: (event: "error", listener: (error: Error) => void) => void;
  off: (event: "error", listener: (error: Error) => void) => void;
  end: (chunk?: string | Uint8Array, callback?: () => void) => void;
};

export type NodeHttpServer = {
  listen: (port: number, host: string, callback: () => void) => void;
  close: (callback: (error?: Error) => void) => void;
  once: (
    event: "error" | "close",
    listener: ((error: Error) => void) | (() => void)
  ) => void;
  off: (event: "error", listener: (error: Error) => void) => void;
};

export type NodeHttpModule = {
  createServer: (
    handler: (
      request: NodeHttpIncomingMessage,
      response: NodeHttpServerResponse
    ) => void
  ) => NodeHttpServer;
};

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

export const maybeNodeHttp = async (): Promise<NodeHttpModule | undefined> => {
  const nodeHttpSpecifier = ["node", "http"].join(":");
  try {
    const importModule = new Function(
      "specifier",
      "return import(specifier);"
    ) as (specifier: string) => Promise<unknown>;
    const mod = await importModule(nodeHttpSpecifier);
    return mod as unknown as NodeHttpModule;
  } catch {
    try {
      const mod = await import(/* @vite-ignore */ nodeHttpSpecifier);
      return mod as unknown as NodeHttpModule;
    } catch {
      return undefined;
    }
  }
};
