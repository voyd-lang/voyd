import { compile } from "../compiler";

const code = `
    def fib(n: i32) -> i32 {
        if n < 2 { return n }
        return fib(n - 2) + fib(n - 1)
    }

    let count = 10
    print(fib(count))
`;

const mod = compile(code);
mod.validate();

WebAssembly.instantiate(mod.emitBinary(), {
    imports: {
        print(v: number) {
            console.log(v);
        }
    }
}).then(result => {
    const exports = result.instance.exports;
    (exports as any).main();
}).catch(console.error);

mod.dispose();
