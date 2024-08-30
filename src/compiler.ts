import { processSemantics } from "./semantics/index.js";
import binaryen from "binaryen";
import { assemble } from "./assembler.js";
import {
  ParsedModule,
  parseModuleFromSrc,
  parseModule,
} from "./parser/index.js";

export const compileText = async (text: string) => {
  const parsedModule = await parseModule(text);
  return compileParsedModule(parsedModule);
};

export const compileSrc = async (path: string) => {
  const parsedModule = await parseModuleFromSrc(path);
  return compileParsedModule(parsedModule);
};

export const compileParsedModule = (module: ParsedModule): binaryen.Module => {
  const typeCheckedModule = processSemantics(module);
  return assemble(typeCheckedModule);
};
