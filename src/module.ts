import { AST } from "./parser";
import { Scope } from "./scope";

export interface Module {
    name: string;
    subModules: { [name: string]: Module }
    scope: Scope;
    ast: AST;
}
