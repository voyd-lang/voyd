import { List } from "../syntax-objects/list.mjs";
import { surfaceLanguage } from "./surface-language/index.mjs";

export const expandSyntaxMacros = (ast: List): List => surfaceLanguage(ast);
