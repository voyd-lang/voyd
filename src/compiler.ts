import binaryen from "binaryen";
import { promises as fs } from "fs";
import { parse } from "./parser";
import { scanForEntities } from "./entity-scanner";
import { Assembler } from "./assembler";
import { analyseSemantics } from "./semantic-analyser";
import { Module } from "./module";
import { parse as pathParse } from "path";
import { walkDir } from "./helpers";

export async function compile(path: string): Promise<binaryen.Module> {
    const rootModule = new Module({ name: "root" });

    const stdModule = await buildModuleTree(`${__dirname}/../std`, rootModule);
    scanForEntities(stdModule);
    analyseSemantics(stdModule);

    const userModule = rootModule.sub("user");
    userModule.scope.import(stdModule.subModules["mod"].exports);
    await buildModuleTree(path, userModule);

    scanForEntities(userModule);
    analyseSemantics(userModule);

    const assembler = new Assembler();
    assembler.compile(rootModule);
    return assembler.mod;
}

async function buildModuleTree(path: string, parent: Module): Promise<Module> {
    const stats = await fs.lstat(path);
    const pathInfo = pathParse(path);
    const module = parent.sub(pathInfo.name);

    if (stats.isDirectory()) {
        const children = (await walkDir(path))
            .filter(item => item.type === "dir" || item.extension === ".dm");

        for (const child of children) {
            await buildModuleTree(child.path, module)
        }

        return module;
    }

    if (pathInfo.ext !== ".dm") {
        throw new Error(`File must have .dm extension. ${path}`);
    }

    const code = await fs.readFile(path, { encoding: "utf8" });
    module.ast = parse(code, module.scope);

    return module;
}
