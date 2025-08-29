import { processSemantics } from "./semantics/index.js";
import binaryen from "binaryen";
import { codegen } from "./codegen.js";
import {
  ParsedModule,
  parseModuleFromSrc,
  parseModule,
} from "./parser/index.js";
import { getStdLib } from "./lib/std-cache.js";

export const compile = async (text: string) => {
  await getStdLib();
  const parsedModule = await parseModule(text);
  return compileParsedModule(parsedModule);
};

export const compileSrc = async (path: string) => {
  await getStdLib();
  const parsedModule = await parseModuleFromSrc(path);
  return compileParsedModule(parsedModule);
};

export const compileParsedModule = (module: ParsedModule): binaryen.Module => {
  const typeCheckedModule = processSemantics(module);
  return codegen(typeCheckedModule);
};
