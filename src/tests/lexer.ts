import { tokenize, keywords, operators } from "../lexer";
import { strict } from "assert";
const assert = strict;

describe("Lexer", function() {
    it("should identify keywords", function() {
        for (const keyword of keywords) {
            const token = tokenize(keyword)[0];
            assert(token && token.type === "keyword");
        }
    });

    it("should identify operators", function() {
        for (const operator of operators) {
            const token = tokenize(operator)[0];
            assert(token && token.type === "operator");
        }
    });

    it("should identify identifiers", function() {
        const identifiers = ["test", "h12g", "Nugget", "fail"];
        for (const identifier of identifiers) {
            const token = tokenize(identifier)[0];
            assert(token && token.type === "identifier");
        }
    });

    it("should identify integers", function() {
        const integers = ["1", "14", "-600", "10002020202"];
        for (const int of integers) {
            const token = tokenize(int)[0];
            assert(token && token.type === "int" && token.value === int);
        }
    });

    it("should identify floats", function() {
        const floats = ["1.0", "-14.24234", "600.234", "-3453.2346"];
        for (const float of floats) {
            const token = tokenize(float)[0];
            assert(token && token.type === "float" && token.value === float);
        }
    });

    it("should correctly tokenize a semi-complex code snippet", function() {
        assert.deepStrictEqual(tokenize(semiComplexCodeSnippet), correctTokensOfSemiComplexCodeSnippet);
    });
});

const semiComplexCodeSnippet = `
    fn fib(n: i32) -> i32 {
        if n < 2 { return n }
        fib(n - 2) + fib(n - 1)
    }

    print(fib(10))
`;

const correctTokensOfSemiComplexCodeSnippet = [
    { type: '\n', value: '\n' },
    { type: 'keyword', value: 'fn' },
    { type: 'identifier', value: 'fib' },
    { type: '(', value: '(' },
    { type: 'identifier', value: 'n' },
    { type: ':', value: ':' },
    { type: 'identifier', value: 'i32' },
    { type: ')', value: ')' },
    { type: '->', value: '->' },
    { type: 'identifier', value: 'i32' },
    { type: '{', value: '{' },
    { type: '\n', value: '\n' },
    { type: 'keyword', value: 'if' },
    { type: 'identifier', value: 'n' },
    { type: 'operator', value: '<' },
    { type: 'int', value: '2' },
    { type: '{', value: '{' },
    { type: 'keyword', value: 'return' },
    { type: 'identifier', value: 'n' },
    { type: '}', value: '}' },
    { type: '\n', value: '\n' },
    { type: 'identifier', value: 'fib' },
    { type: '(', value: '(' },
    { type: 'identifier', value: 'n' },
    { type: 'operator', value: '-' },
    { type: 'int', value: '2' },
    { type: ')', value: ')' },
    { type: 'operator', value: '+' },
    { type: 'identifier', value: 'fib' },
    { type: '(', value: '(' },
    { type: 'identifier', value: 'n' },
    { type: 'operator', value: '-' },
    { type: 'int', value: '1' },
    { type: ')', value: ')' },
    { type: '\n', value: '\n' },
    { type: '}', value: '}' },
    { type: '\n', value: '\n' },
    { type: '\n', value: '\n' },
    { type: 'identifier', value: 'print' },
    { type: '(', value: '(' },
    { type: 'identifier', value: 'fib' },
    { type: '(', value: '(' },
    { type: 'int', value: '10' },
    { type: ')', value: ')' },
    { type: ')', value: ')' },
    { type: '\n', value: '\n' }
];
