import { SemanticAnalyzer } from "../semantic-analyzer";
import { EntityCollection } from "../entity-collection";
import { readFileSync } from "fs";
import { Scope } from "../scope";
import { parse } from "../parser";

console.dir(parse("hello.world.today"), { depth: 20 });
console.dir(parse("hello.world.today()"), { depth: 20 });

// const code = `
//     fn fib(n: i32) -> i32 {
//         if n < 2 { return n }
//         fib(n - 2) + fib(n - 1)
//     }

//     print(fib(10))
// `;

// const ast = parse(code);
// scanner.scan(ast, stdScope.newSubScope());
// console.dir(ast, { depth: 20 });
