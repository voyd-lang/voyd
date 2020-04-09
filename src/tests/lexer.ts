import { lexer } from "../lexer";
import { readFile } from "fs";

readFile(`${__dirname}/../../example.dm`, { encoding: "utf8" }, (err, data) => {
    if (err) {
        console.log(err);
        return;
    }

    console.dir(lexer(data));
});
