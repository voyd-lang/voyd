import { parse } from "../parser";

const code = `
    var count = 0

    while count < 7 {
        count = count + 1
    }

    print(count)
`;

console.dir(parse(code), { depth: 5 });
