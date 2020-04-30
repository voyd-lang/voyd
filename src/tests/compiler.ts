import { compile } from "../compiler";

const code = `
    def exp(to: i32) {
        var count = 1
        while count < to {
            print(count)
            count = count * 2
        }
    }

    exp(10000)
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
