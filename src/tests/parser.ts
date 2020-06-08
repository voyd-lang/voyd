import { parse, AST } from "../parser";
import { strict as assert } from "assert";

describe("Parser", function() {
    it("should parse a basic enum", function() {
        assert.deepStrictEqual(parse(enumSnippet), correctEnumAst);
    });

    it("should parse a basic code snippet", function() {
        assert.deepStrictEqual(parse(basicCodeSnippet), correctBasicCodeSnippetAST);
    });

    it("should parse a basic match expression", function() {
        assert.deepStrictEqual(parse(basicMatchExpression), correctBasicMatchExpressionAST);
    });

    it("should parse the different function syntaxes", function() {
        assert.deepStrictEqual(parse(fnSyntax1), correctFnSyntax1AST);
        assert.deepStrictEqual(parse(fnSyntax2), correctFnSyntax2AST);
        assert.deepStrictEqual(parse(fnSyntax3), correctFnSyntax3AST);
    });

    it("Should parse property access expressions", function() {
        assert.deepStrictEqual(parse(basicPropertyAccessSnippet), correctBasicPropertyAccessAST);
    });

    it("Should parse a property accessed function", function() {
        assert.deepStrictEqual(parse(propertyAccessFnCallSnippet), correctPropertyAccessFnCallAST);
    });

    it("Should parse impl declarations without a trait", function() {
        assert.deepStrictEqual(parse(implWithoutTraitSnippet), correctImplWithoutTraitAST);
    });

    it("Should parse an impl declaration with a trait", function() {
        assert.deepStrictEqual(parse(implWithTraitSnippet), correctImplWithTraitAST);
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

const correctBasicCodeSnippetAST: AST = [
    {
        kind: 'function-declaration',
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
        expression: {
            kind: "block-expression",
            flags: [],
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
                    ],
                    elifBodies: [],
                    elseBody: undefined
                },
                {
                    kind: 'binary-expression',
                    calleeLabel: '+',
                    arguments: [
                        {
                            kind: 'call-expression',
                            callee: { kind: 'identifier', label: 'fib' },
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
                            callee: { kind: 'identifier', label: 'fib' },
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
            ]
        },
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'call-expression',
        callee: { kind: 'identifier', label: 'print' },
        arguments: [
            {
                kind: 'call-expression',
                callee: { kind: 'identifier', label: 'fib' },
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
                    callee: { kind: 'identifier', label: 'print' },
                    arguments: [{ kind: 'int-literal', value: '3' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'int-literal', value: '2' },
                expression: {
                    kind: 'call-expression',
                    callee: { kind: 'identifier', label: 'print' },
                    arguments: [{ kind: 'int-literal', value: '2' }]
                }
            },
            {
                kind: 'match-case',
                case: { kind: 'int-literal', value: '3' },
                expression: {
                    kind: 'call-expression',
                    callee: { kind: 'identifier', label: 'print' },
                    arguments: [{ kind: 'int-literal', value: '1' }]
                }
            }
        ],
        flags: []
    }
];

const fnSyntax1 = `
    fn add(a: i32, b: i32) = a + b
    fn sub(a: i32, b: i32) -> i32 = a - b
`

const fnSyntax2 = `
    fn add(a: i32, b: i32) = { a + b }
    fn sub(a: i32, b: i32) -> i32 = { a - b }
`

const fnSyntax3 = `
    fn add(a: i32, b: i32) { a + b }
    fn sub(a: i32, b: i32) -> i32 { a - b }
`

const correctFnSyntax1AST = [
    {
        kind: 'function-declaration',
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
        kind: 'function-declaration',
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

const correctFnSyntax2AST = [
    {
        kind: 'function-declaration',
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
                kind: 'block-expression',
                flags: [],
                body: [
                    {
                        kind: 'binary-expression',
                        calleeLabel: '+',
                        arguments: [
                            { kind: 'identifier', label: 'a' },
                            { kind: 'identifier', label: 'b' }
                        ]
                    }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    },
    {
        kind: 'function-declaration',
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
                kind: 'block-expression',
                flags: [],
                body: [
                    {
                        kind: 'binary-expression',
                        calleeLabel: '-',
                        arguments: [
                            { kind: 'identifier', label: 'a' },
                            { kind: 'identifier', label: 'b' }
                        ]
                    }
                ]
            }
        ],
        typeParameters: [],
        flags: ['fn']
    }
];

const correctFnSyntax3AST = [
    {
        kind: 'function-declaration',
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
        kind: 'function-declaration',
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

const basicPropertyAccessSnippet = `
    my.property.access.example
`

const correctBasicPropertyAccessAST = [
    {
        kind: 'property-access-expression',
        arguments: [
            {
                kind: 'property-access-expression',
                arguments: [
                    {
                        kind: 'property-access-expression',
                        arguments: [
                            { kind: 'identifier', label: 'my' },
                            { kind: 'identifier', label: 'property' }
                        ]
                    },
                    { kind: 'identifier', label: 'access' }
                ]
            },
            { kind: 'identifier', label: 'example' }
        ]
    }
];

const propertyAccessFnCallSnippet = `
    call.this.func()
`

const correctPropertyAccessFnCallAST = [
    {
        kind: 'call-expression',
        callee: {
            kind: 'property-access-expression',
            arguments: [
                {
                    kind: 'property-access-expression',
                    arguments: [
                        { kind: 'identifier', label: 'call' },
                        { kind: 'identifier', label: 'this' }
                    ]
                },
                { kind: 'identifier', label: 'func' }
            ]
        },
        arguments: []
    }
];

const implWithoutTraitSnippet = `
    declare type i32

    impl i32 {
        fn to_f32() = unsafe {
            i32_to_f32(self)
        }

        fn min(other: i32) = if self < other { self } else { other }
    }
`

const correctImplWithoutTraitAST = [
    {
        kind: 'type-declaration',
        label: 'i32',
        flags: ['declare', 'type'],
        type: { kind: 'type-argument', label: '', flags: [] }
    },
    {
        kind: 'impl-declaration',
        flags: ['impl'],
        trait: undefined,
        target: 'i32',
        functions: [
            {
                kind: 'function-declaration',
                label: 'to_f32',
                parameters: [],
                returnType: undefined,
                body: [
                    {
                        kind: 'block-expression',
                        flags: ['unsafe'],
                        body: [
                            {
                                kind: 'call-expression',
                                callee: { kind: 'identifier', label: 'i32_to_f32' },
                                arguments: [{ kind: 'identifier', label: 'self' }]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['fn']
            },
            {
                kind: 'function-declaration',
                label: 'min',
                parameters: [
                    {
                        kind: 'parameter-declaration',
                        label: 'other',
                        type: { kind: 'type-argument', label: 'i32', flags: [] },
                        flags: []
                    }
                ],
                returnType: undefined,
                body: [
                    {
                        kind: 'if-expression',
                        condition: {
                            kind: 'binary-expression',
                            calleeLabel: '<',
                            arguments: [
                                { kind: 'identifier', label: 'self' },
                                { kind: 'identifier', label: 'other' }
                            ]
                        },
                        body: [{ kind: 'identifier', label: 'self' }],
                        elifBodies: [],
                        elseBody: [
                            {
                                kind: 'block-expression',
                                flags: [],
                                body: [{ kind: 'identifier', label: 'other' }]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['fn']
            }
        ]
    }
];

const implWithTraitSnippet = `
    declare type i32

    impl Numerical for i32 {
        pure fn +(r: i32) = unsafe {
            i32_add(self, r)
        }

        pure fn -(r: i32) = unsafe {
            i32_sub(self, r)
        }

        pure fn /(r: i32) = unsafe {
            i32_div_s(self, r)
        }

        pure fn *(r: i32) = unsafe {
            i32_mul(self, r)
        }
    }
`;

const correctImplWithTraitAST = [
    {
        kind: 'type-declaration',
        label: 'i32',
        flags: ['declare', 'type'],
        type: { kind: 'type-argument', label: '', flags: [] }
    },
    {
        kind: 'impl-declaration',
        flags: ['impl'],
        trait: 'Numerical',
        target: 'i32',
        functions: [
            {
                kind: 'function-declaration',
                label: '+',
                parameters: [
                    {
                        kind: 'parameter-declaration',
                        label: 'r',
                        type: { kind: 'type-argument', label: 'i32', flags: [] },
                        flags: []
                    }
                ],
                returnType: undefined,
                body: [
                    {
                        kind: 'block-expression',
                        flags: ['unsafe'],
                        body: [
                            {
                                kind: 'call-expression',
                                callee: { kind: 'identifier', label: 'i32_add' },
                                arguments: [
                                    { kind: 'identifier', label: 'self' },
                                    { kind: 'identifier', label: 'r' }
                                ]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['pure', 'fn']
            },
            {
                kind: 'function-declaration',
                label: '-',
                parameters: [
                    {
                        kind: 'parameter-declaration',
                        label: 'r',
                        type: { kind: 'type-argument', label: 'i32', flags: [] },
                        flags: []
                    }
                ],
                returnType: undefined,
                body: [
                    {
                        kind: 'block-expression',
                        flags: ['unsafe'],
                        body: [
                            {
                                kind: 'call-expression',
                                callee: { kind: 'identifier', label: 'i32_sub' },
                                arguments: [
                                    { kind: 'identifier', label: 'self' },
                                    { kind: 'identifier', label: 'r' }
                                ]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['pure', 'fn']
            },
            {
                kind: 'function-declaration',
                label: '/',
                parameters: [
                    {
                        kind: 'parameter-declaration',
                        label: 'r',
                        type: { kind: 'type-argument', label: 'i32', flags: [] },
                        flags: []
                    }
                ],
                returnType: undefined,
                body: [
                    {
                        kind: 'block-expression',
                        flags: ['unsafe'],
                        body: [
                            {
                                kind: 'call-expression',
                                callee: { kind: 'identifier', label: 'i32_div_s' },
                                arguments: [
                                    { kind: 'identifier', label: 'self' },
                                    { kind: 'identifier', label: 'r' }
                                ]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['pure', 'fn']
            },
            {
                kind: 'function-declaration',
                label: '*',
                parameters: [
                    {
                        kind: 'parameter-declaration',
                        label: 'r',
                        type: { kind: 'type-argument', label: 'i32', flags: [] },
                        flags: []
                    }
                ],
                returnType: undefined,
                body: [
                    {
                        kind: 'block-expression',
                        flags: ['unsafe'],
                        body: [
                            {
                                kind: 'call-expression',
                                callee: { kind: 'identifier', label: 'i32_mul' },
                                arguments: [
                                    { kind: 'identifier', label: 'self' },
                                    { kind: 'identifier', label: 'r' }
                                ]
                            }
                        ]
                    }
                ],
                typeParameters: [],
                flags: ['pure', 'fn']
            }
        ]
    }
];
