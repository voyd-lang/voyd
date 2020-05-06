import { compile } from "../compiler";

const code = `
    match 2 {
        1 => print(1),
        2 => print(2),
        3 => print(3),
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
