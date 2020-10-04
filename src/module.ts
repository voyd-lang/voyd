import { AST } from "./parser";
import { Scope } from "./scope";

/** TODO: Possibly merge with scope? Lots of shared responsibilities. */
export class Module {
    readonly name: string;
    readonly parent?: Module;
    readonly subModules: { [name: string]: Module } = {};
    readonly scope: Scope;
    ast: AST;

    constructor(opts: {
        name: string,
        parent?: Module,
        ast?: AST
    }) {
        this.name = opts.name;
        this.parent = opts.parent;
        this.scope = opts.parent ? opts.parent.scope.sub("module") : new Scope("module");
        this.ast = opts.ast ?? [];
    }

    get exports() {
        return this.scope.exports;
    }

    sub(name: string): Module {
        this.subModules[name] = new Module({ name, parent: this });
        return this.subModules[name];
    }
}
