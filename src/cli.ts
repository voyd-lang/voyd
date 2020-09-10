#!/usr/bin/env node
import { createCommand } from "commander";
import { readFileSync } from "fs";
import { run } from "./run";
import { compile } from "./compiler";

const program = createCommand();

program
    .version(JSON.parse(readFileSync(`${__dirname}/../package.json`, { encoding: "utf8" })))
    .arguments("<file.dm>")
    .action((file: string) => {
        const code = readFileSync(file, { encoding: "utf8" });
        const mod = compile(code);
        run(mod);
    });

program.parse();
