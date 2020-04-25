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

    if (!mod.validate()) return;

    console.log(mod.emitText());
    mod.dispose();
});
