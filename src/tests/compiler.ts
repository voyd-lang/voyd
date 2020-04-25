import { lexer } from "../lexer";
import { readFile } from "fs";
import { parser } from "../parser";
import { compile } from "../compiler";

readFile(`${__dirname}/../../example.dm`, { encoding: "utf8" }, (err, data) => {
    if (err) {
        console.log(err);
        return;
    }

    const tokens = lexer(data);
    const ast = parser(tokens)
    const mod = compile(ast);
    mod.validate()
    console.log(mod.emitText());

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
});
