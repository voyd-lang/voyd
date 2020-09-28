#!/usr/bin/env node --experimental-wasm-modules
import { createCommand } from "commander";
import { readFileSync } from "fs";
import { run } from "./run";
import { compile } from "./compiler";
import { parse } from "./parser";

const program = createCommand();

program
    .version(JSON.parse(readFileSync(`${__dirname}/../package.json`, { encoding: "utf8" })))
    .arguments("<file.dm>")
    .option("-a, --ast", "Output parser ast only.")
    .action((file: string, opts) => {
        const code = readFileSync(file, { encoding: "utf8" });
        if (opts.ast) {
            console.log(JSON.stringify(parse(code), undefined, 4))
            return;
        }

        const mod = compile(code);
        run(mod);
    });

program.parse();
