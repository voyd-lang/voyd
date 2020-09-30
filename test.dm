
let a = [
    b: [
        x: 1
    ]
]

a.b.x = 5

/** AST:

{
    "body": [
        {
            "kind": "assignment",
            "assignee": {
                "kind": "property-access-expression",
                "arguments": [
                    {
                        "kind": "property-access-expression",
                        "arguments": [
                            {
                                "kind": "identifier",
                                "label": "a",
                                "tokenIndex": 0
                            },
                            {
                                "kind": "identifier",
                                "label": "b",
                                "tokenIndex": 2
                            }
                        ]
                    },
                    {
                        "kind": "identifier",
                        "label": "x",
                        "tokenIndex": 4
                    }
                ]
            },
            "expression": {
                "kind": "int-literal",
                "value": "5"
            }
        }
    ],
    "scope": {}
}

*/

let newB = tuple.make()
