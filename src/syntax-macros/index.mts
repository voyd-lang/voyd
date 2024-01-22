import { surfaceLanguage } from "./surface-language/index.mjs";
import { List } from "../lib/index.mjs";

export const expandSyntaxMacros = (ast: List): List => surfaceLanguage(ast);
