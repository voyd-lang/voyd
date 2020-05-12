import { parse, AST } from "../parser";
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

    it("should parse the different method syntaxes", function() {
        assert.deepStrictEqual(parse(methodSyntax1), correctMethodSyntax1AST);
        assert.deepStrictEqual(parse(methodSyntax2), correctMethodSyntax2AST);
        assert.deepStrictEqual(parse(methodSyntax3), correctMethodSyntax3AST);
    });
});

const enumSnippet = `
    enum Friends {
        dan, paige, jimmy, glados
    }
`;

const correctEnumAst: AST = [
    {
        kind: 'enum-declaration',
        label: 'Friends',
        flags: ['enum'],
        variants: [
            {
                kind: 'enum-variant',
                label: 'dan',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                label: 'paige',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                label: 'jimmy',
                parentEnum: 'Friends',
                flags: []
            },
            {
                kind: 'enum-variant',
                label: 'glados',
                parentEnum: 'Friends',
                flags: []
            }
        ],
        typeParameters: []
    }
];

const basicCodeSnippet = `
    fn fib(n: i32) -> i32 {
        if n < 2 { return n }
        fib(n - 2) + fib(n - 1)
    }

    print(fib(10))
`;

const correctCodeSnippetAST: AST = [
    {
        kind: 'method-declaration',
        label: 'fib',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'n',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: { kind: 'type-argument', label: 'i32', flags: [] },
        body: [
            {
                kind: 'if-expression',
                condition: {
                    kind: 'binary-expression',
                    calleeLabel: '<',
                    arguments: [
                        { kind: 'identifier', label: 'n' },
                        { kind: 'int-literal', value: '2' }
                    ]
                },
                body: [
                    {
                        kind: 'return-statement',
                        expression: { kind: 'identifier', label: 'n' }
                    }
                ]
            },
            {
                kind: 'binary-expression',
                calleeLabel: '+',
                arguments: [
                    {
                        kind: 'call-expression',
                        calleeLabel: 'fib',
                        arguments: [
                            {
                                kind: 'binary-expression',
                                calleeLabel: '-',
                                arguments: [
                                    { kind: 'identifier', label: 'n' },
                                    { kind: 'int-literal', value: '2' }
                                ]
                            }
                        ]
                    },
                    {
                        kind: 'call-expression',
                        calleeLabel: 'fib',
                        arguments: [
                            {
                                kind: 'binary-expression',
                                calleeLabel: '-',
                                arguments: [
                                    { kind: 'identifier', label: 'n' },
                                    { kind: 'int-literal', value: '1' }
                                ]
                            }
                        ]
                    }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'call-expression',
        calleeLabel: 'print',
        arguments: [
            {
                kind: 'call-expression',
                calleeLabel: 'fib',
                arguments: [{ kind: 'int-literal', value: '10' }]
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

const correctBasicMatchExpressionAST: AST = [
    {
        kind: 'match-expression',
        value: { kind: 'int-literal', value: '3' },
        cases: [
            {
                kind: 'match-case',
                case: { kind: 'int-literal', value: '1' },
                expression: {
                    kind: 'call-expression',
                    calleeLabel: 'print',
                    arguments: [{ kind: 'int-literal', value: '3' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'int-literal', value: '2' },
                expression: {
                    kind: 'call-expression',
                    calleeLabel: 'print',
                    arguments: [{ kind: 'int-literal', value: '2' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'int-literal', value: '3' },
                expression: {
                    kind: 'call-expression',
                    calleeLabel: 'print',
                    arguments: [{ kind: 'int-literal', value: '1' }]
                }
            }
        ],
        flags: []
    }
];

const methodSyntax1 = `
    fn add(a: i32, b: i32) = a + b
    fn sub(a: i32, b: i32) -> i32 = a - b
`

const methodSyntax2 = `
    fn add(a: i32, b: i32) = { a + b }
    fn sub(a: i32, b: i32) -> i32 = { a - b }
`

const methodSyntax3 = `
    fn add(a: i32, b: i32) { a + b }
    fn sub(a: i32, b: i32) -> i32 { a - b }
`

const correctMethodSyntax1AST = [
    {
        kind: 'method-declaration',
        label: 'add',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: undefined,
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '+',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'method-declaration',
        label: 'sub',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: { kind: 'type-argument', label: 'i32', flags: [] },
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '-',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    }
];

const correctMethodSyntax2AST = [
    {
        kind: 'method-declaration',
        label: 'add',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: undefined,
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '+',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'method-declaration',
        label: 'sub',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: { kind: 'type-argument', label: 'i32', flags: [] },
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '-',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    }
];

const correctMethodSyntax3AST = [
    {
        kind: 'method-declaration',
        label: 'add',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: undefined,
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '+',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'method-declaration',
        label: 'sub',
        parameters: [
            {
                kind: 'parameter-declaration',
                label: 'a',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            },
            {
                kind: 'parameter-declaration',
                label: 'b',
                type: { kind: 'type-argument', label: 'i32', flags: [] },
                flags: []
            }
        ],
        returnType: { kind: 'type-argument', label: 'i32', flags: [] },
        body: [
            {
                kind: 'binary-expression',
                calleeLabel: '-',
                arguments: [
                    { kind: 'identifier', label: 'a' },
                    { kind: 'identifier', label: 'b' }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    }
];
