import { parse } from "../parser";
import { scanForEntities } from "../entity-scanner/entity-scanner";

const basicCodeSnippet = `
declare type i32

impl i32 {
    pure fn +(r: i32) = unsafe {
        i32_add(self, r)
    }
}
`;

const ast = parse(basicCodeSnippet);
scanForEntities(ast);
console.dir(ast, { depth: 20 });
