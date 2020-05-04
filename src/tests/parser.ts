import { parse } from "../parser";
import { strict as assert } from "assert";

describe("Parser", function() {
    it("should parse a basic enum", function() {
        assert.deepStrictEqual(parse(enumSnippet), correctEnumAst);
    });

    it("should parse a basic code snippet", function() {
        assert.deepStrictEqual(parse(basicCodeSnippet), correctCodeSnippetAST);
    });

    it("should parse a basic match expression", function() {
        assert.deepStrictEqual(parse(basicMatchExpression), correctBasicMatchExpressionAST);
    });
});

const enumSnippet = `
    enum Friends {
        dan, paige, jimmy, glados
    }
`;

const correctEnumAst = [
    {
        kind: 'enum-declaration',
        identifier: 'Friends',
        flags: ['enum'],
        variants: [
            {
                kind: 'enum-variant',
                identifier: 'dan',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                identifier: 'paige',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                identifier: 'jimmy',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                identifier: 'glados',
                parentEnum: 'Friends',
                flags: []
            }
        ],
        typeParameters: []
    }
];

const basicCodeSnippet = `
    def fib(n: i32) -> i32 {
        if n < 2 { return n }
        fib(n - 2) + fib(n - 1)
    }

    print(fib(10))
`;

const correctCodeSnippetAST = [
    {
        kind: 'method-declaration',
        identifier: 'fib',
        parameters: [
            {
                kind: 'parameter-declaration',
                identifier: 'n',
                type: { kind: 'type-argument', identifier: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: { kind: 'type-argument', identifier: 'i32', flags: [] },
        body: [
            {
                kind: 'if-expression',
                condition: {
                    kind: 'method-or-function-call',
                    identifier: '<',
                    arguments: [
                        { kind: 'i32-literal', value: '2' },
                        { kind: 'identifier', value: 'n' }
                    ]
                },
                body: [
                    {
                        kind: 'return-statement',
                        expression: { kind: 'identifier', value: 'n' }
                    }
                ]
            },
            {
                kind: 'method-or-function-call',
                identifier: '+',
                arguments: [
                    {
                        kind: 'method-or-function-call',
                        identifier: 'fib',
                        arguments: [
                            {
                                kind: 'method-or-function-call',
                                identifier: '-',
                                arguments: [
                                    { kind: 'i32-literal', value: '1' },
                                    { kind: 'identifier', value: 'n' }
                                ]
                            }
                        ]
                    },
                    {
                        kind: 'method-or-function-call',
                        identifier: 'fib',
                        arguments: [
                            {
                                kind: 'method-or-function-call',
                                identifier: '-',
                                arguments: [
                                    { kind: 'i32-literal', value: '2' },
                                    { kind: 'identifier', value: 'n' }
                                ]
                            }
                        ]
                    }
                ]
            }
        ],
        typeParameters: [],
        flags: ['def']
    },
    {
        kind: 'method-or-function-call',
        identifier: 'print',
        arguments: [
            {
                kind: 'method-or-function-call',
                identifier: 'fib',
                arguments: [{ kind: 'i32-literal', value: '10' }]
            }
        ]
    }
];

const basicMatchExpression = `
match 3 {
    1 => print(3),
    2 => print(2),
    3 => print(1)
}
`

const correctBasicMatchExpressionAST = [
    {
        kind: 'match-expression',
        expression: { kind: 'i32-literal', value: '3' },
        cases: [
            {
                kind: 'match-case',
                case: { kind: 'i32-literal', value: '1' },
                expression: {
                    kind: 'method-or-function-call',
                    identifier: 'print',
                    arguments: [{ kind: 'i32-literal', value: '3' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'i32-literal', value: '2' },
                expression: {
                    kind: 'method-or-function-call',
                    identifier: 'print',
                    arguments: [{ kind: 'i32-literal', value: '2' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'i32-literal', value: '3' },
                expression: {
                    kind: 'method-or-function-call',
                    identifier: 'print',
                    arguments: [{ kind: 'i32-literal', value: '1' }]
                }
            }
        ],
        flags: []
    }
];
