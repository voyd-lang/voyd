# Expanded Form

The expanded form is a pure s-expression based syntax with an
extremely simple grammar. There are no infix operators, prefix function notation etc.

## Full Grammar

```ebnf
SExpr = AtomicSymbol | List;

List = OpenBracket SExpr* CloseBracket;

OpenBracket = Empty* "(" Empty*

CloseBracket = Empty* ")" Empty*

AtomicSymbol = !Number (Alphanumeric+ | Empty+);

Alphanumeric = #'[^\s\(\)]';

Number = Int | Float;

Int = #'^[+-]?\d+$';

Float = #'^[+-]?\d+\.\d+$';

Empty = " ";
```

## Expanded Meta Syntax Grammar

A modified version of the full expanded form grammar is used to
define syntax elsewhere in this spec.

Note: Optional is equivalent to `Atom | ()`;

```ebnf
SExpr = Atom | List | Or | ZeroOrMore | OneOrMore | Optional | Argument;

Optional =  Atom "?";

OneOrMore =  Atom "+";

ZeoOrMore =  Atom "*";

Argument =  "$" Symbol

Or = Atom Empty* "|" Empty* Atom;

Atom = List | Symbol;

List = "(" Empty * SExpr* Empty* ")";

Symbol = !Number (Alphanumeric+ | Empty+);

Alphanumeric = #'[^\s\(\)\?\|\+\*\[\]\$]';

Number = Int | Float;

Int = #'^[+-]?\d+$';

Float = #'^[+-]?\d+\.\d+$';

Empty = " ";
```
