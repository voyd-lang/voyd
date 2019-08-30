import { Tokens, TokenType } from "./definitions";

function extractMatch({ buffer, exp, type, tokens, line }: {
    buffer: string, exp: RegExp, type: TokenType, tokens: Tokens,
    line: number
}): { matched: boolean, newBuffer: string } {
    let newBuffer = buffer;
    let matched = false;
    const match = newBuffer.match(exp);
    if (match) {
        matched = true;
        tokens.push({ type, value: match[0], line });
        newBuffer = newBuffer.slice(match[0].length);
    }
    return { newBuffer, matched };
}

function extractIndentaiton(buffer: string, tokens: Tokens, line: number): string {
    let newBuffer = buffer;
    while (/^    /.test(newBuffer)) {
        newBuffer = newBuffer.slice(3);
        tokens.push({ type: "indent", value: "    ", line });
    }
    return newBuffer;
}

export function lex(code: string): Tokens {
    const tokens: Tokens = [];
    let buffer = code;
    let line = 1;

    const match = (type: TokenType, exp: RegExp): boolean => {
        const info = extractMatch({ buffer, exp, type, line, tokens });
        buffer = info.newBuffer;
        return info.matched;
    }

    extractIndentaiton(buffer, tokens, line);
    while (buffer.length > 0) {
        if (match("fn", /^fn/)) continue;
        if (match("interface", /^interface/)) continue;
        if (match("object", /^object/)) continue;
        if (match("enum", /^enum/)) continue;
        if (match("case", /^case/)) continue;
        if (match("let", /^let/)) continue;
        if (match("var", /^var/)) continue;
        if (match("if", /^if/)) continue;
        if (match("else", /^else/)) continue;
        if (match("for", /^for/)) continue;
        if (match("in", /^in/)) continue;
        if (match("self", /^self/)) continue;
        if (match("return", /^return/)) continue;
        if (match("yeild", /^yeild/)) continue;
        if (match("async", /^async/)) continue;
        if (match("await", /^await/)) continue;
        if (match("false", /^false/)) continue;
        if (match("true", /^true/)) continue;
        if (match("colon", /^:/)) continue;
        if (match("equal", /^=/)) continue;
        if (match("left-paren", /^\(/)) continue;
        if (match("right-paren", /^\)/)) continue;
        if (match("left-curly", /^{/)) continue;
        if (match("right-curly", /^}/)) continue;
        if (match("left-square", /^\[/)) continue;
        if (match("right-square", /^\]/)) continue;
        if (match("identifier", /^[a-zA-Z_]\w*/)) continue;
        if (match("double", /^\d+\.\d+/)) continue;
        if (match("int", /^\d+/)) continue;
        if (match("comma", /^,/)) continue;
        if (match("operator", /^[+\-/!@%?\.\*><=]+/)) continue;
        if (match("new-line", /^\n/)) {
            line += 1;
            extractIndentaiton(buffer, tokens, line);
            continue;
        }

        if (buffer[0] === "\"") {
            const index = buffer.indexOf("\"", 1);
            if (index < 0) throw new Error("Bad comment");
            tokens.push({ type: "comment", value: buffer.slice(0, index + 1), line });
            buffer = buffer.slice(index + 1);
            continue;
        }

        if (buffer[0] === "`") {
            const index = buffer.indexOf("`", 1);
            if (index < 0) {
                console.dir(tokens);
                console.log(buffer);
                throw new Error("Bad string");
            }
            tokens.push({ type: "string", value: buffer.slice(0, index + 1), line });
            buffer = buffer.slice(index + 1);
            continue;
        }

        if (buffer[0] === " ") {
            buffer = buffer.slice(1);
            continue;
        }

        throw new Error("Unexpected character");
    }

    return tokens;
}
