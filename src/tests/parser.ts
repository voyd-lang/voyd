import { lexer } from "../lexer";
import { readFile } from "fs";
import { parser } from "../parser";

readFile(`${__dirname}/../../example.dm`, { encoding: "utf8" }, (err, data) => {
    if (err) {
        console.log(err);
        return;
    }

    const tokens = lexer(data);
    console.dir(parser(tokens));
});
