#!/usr/bin/env node
import { createCommand } from "commander";
import { readFileSync } from "fs";
import { run } from "./run";
import { compile } from "./compiler";
import { parse } from "./parser";
import { Scope } from "./scope";

const program = createCommand();

program
    .version(JSON.parse(readFileSync(`${__dirname}/../package.json`, { encoding: "utf8" })))
    .arguments("<file.dm>")
    .option("-a, --ast", "Output parser ast only.")
    .action(async (file: string, opts) => {
        if (opts.ast) {
            const code = readFileSync(file, { encoding: "utf8" });
            console.log(JSON.stringify(parse(code, new Scope("module")), undefined, 4))
            return;
        }

        const mod = await compile(file);
        run(mod);
    });

program.parse();
