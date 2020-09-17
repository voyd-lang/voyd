import binaryen from "binaryen";
import { readFileSync } from "fs";
import { parse, AST } from "./parser";
import { scanForEntities } from "./entity-scanner";
import { Assembler } from "./assembler";
import { Scope } from "./scope";
import { analyseSemantics } from "./semantic-analyser";

export function compile(code: string): binaryen.Module {
    const std = readFileSync(`${__dirname}/../std/i32.dm`, { encoding: "utf8" });
    const assembler = new Assembler();
    const { ast } = build(std, assembler);
    return build(code, assembler, ast.scope).mod;
}

function build(code: string, assembler: Assembler, scope?: Scope): { ast: AST, mod: binaryen.Module } {
    const ast = parse(code, scope);
    scanForEntities(ast);
    analyseSemantics(ast);
    return { ast, mod: assembler.compile(ast) };
}
