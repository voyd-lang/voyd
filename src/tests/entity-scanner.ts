import { parse } from "../parser";
import { entityScanner } from "../entity-scanner/entity-scanner";

const basicCodeSnippet = `
    fn fib(n: i32) -> i32 {
        if n < 2 { return n }
        fib(n - 2) + fib(n - 1)
    }

    print(fib(10))
`;

const ast = parse(basicCodeSnippet);
entityScanner(ast);
console.dir(ast, { depth: 20 });
