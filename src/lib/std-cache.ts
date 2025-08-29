import binaryen from "binaryen";
import { parseStd, stdPath } from "../parser/index.js";
import { ParsedModule } from "../parser/utils/parse-module.js";
import { processSemantics } from "../semantics/index.js";
import { codegen } from "../codegen.js";
import { RootModule } from "../syntax-objects/module.js";
import fs from "node:fs/promises";
import path from "node:path";

let cached: { root: RootModule; binary: Uint8Array } | undefined;
const cacheFile = path.resolve(stdPath, "..", "std.wasm");

export const getStdLib = async () => {
  if (!cached) {
    try {
      const binary = await fs.readFile(cacheFile);
      const files = await parseStd();
      const parsed: ParsedModule = {
        files,
        indexPath: path.join(stdPath, "index.voyd"),
      };
      const root = processSemantics(parsed) as RootModule;
      cached = { root, binary: new Uint8Array(binary) };
    } catch {
      const files = await parseStd();
      const parsed: ParsedModule = {
        files,
        indexPath: path.join(stdPath, "index.voyd"),
      };
      const root = processSemantics(parsed) as RootModule;
      const mod = codegen(root);
      const binary = mod.emitBinary() as Uint8Array;
      cached = { root, binary };
      try {
        await fs.writeFile(cacheFile, Buffer.from(binary));
      } catch {}
    }
  }

  const mod = binaryen.readBinary(cached.binary);
  return { root: cached.root.clone() as RootModule, mod };
};
