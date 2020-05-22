import { DIRCompiler } from "../dir/dir";
import { parse } from "../parser";


const dir = new DIRCompiler();

const basicCodeSnippet = `
    fn fib(n: i32) -> i32 = {
        if n < 2 { return n }
        fib(n - 2) + fib(n - 1)
    }

    pub fn main() = print(fib())
`;

const ast = parse(basicCodeSnippet);
dir.compile(ast);
