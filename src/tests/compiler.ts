import { compile } from "../compiler";

const code = `
    var count = 0
    while count < 15 {
        count = count + 1
        print(count)
    }
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
