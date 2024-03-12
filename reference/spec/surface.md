# The Surface Language Specification

This specification defines the language users write, the "surface" void
language.

This surface language spec includes:

-   The surface grammar
-   The surface syntax
-   Macros
-   A standard library (Built in macros, types, and functions)
-   More?


# The Surface Language Grammar

```ebnf
(* Whitespace (Significant to the surface level language) *)
Whitespace = Space | Tab | Newline
Space = " ";
Indent = "    ";
NewLine = "\n";
BackSlash = "\\"; // Single back slash character \

(* Comment *)
Comment = "//", { AnyChar - NewLine }, NewLine;

(* Brackets *)
Bracket = "{" | "}" | "[" | "]" | "(" | ")";

(* Operator Characters (does not imply infix, prefix, or postfix) *)
OpChar = "+" | "-" | "*" | "/" | "=" | ":" | "?" | "." | ";" | "<" | ">" | "$" | "!" | "@" | "%" | "^" | "&" | "~" | BackSlash;
Operator = (OpChar, { OpChar });

(* Terminators *)
Terminator = Bracket | Whitespace | TerminatingOperator | Quote | ",";
Quote = '"' | "'" | "`";
TerminatingOperator = (":" | "?" | "!" | "." | ";" | BackSlash), { OpChar } ;

(* Identifier *)
Identifier = StandardIdentifier | QuotedIdentifier | SharpIdentifier;
StandardIdentifier =  (AnyChar - (Number | Terminator)), { AnyChar - Terminator };
QuotedIdentifier = "'", { AnyChar - "'" }, "'";
SharpIdentifier = "#", AnyChar - Whitespace, { AnyChar - Whitespace };

(* Numbers *)
Number = ScientificNumber | Int | Float;
ScientificNumber = #'^[+-]?\d(\.\d+)?[Ee][+-]?\d+$';
Int = #'^[+-]?\d+$';
Float = #'^[+-]?\d+\.\d+$';

(* A string is a sequence of characters surrounded by double quotes *)
String = '"', { AnyChar - '"' }, '"';

(* Symbol *)
Symbol = Number | Identifier | String | Operator;

(* List *)
List = "(", { Symbol | List }, ")"

(* Other *)
AlphabeticChar = #'[a-zA-Z]'
AnyChar = ? all valid characters (including whitespace) ?;
```

## The Syntax Pipeline

In the spirit of lisp, Void language is designed to be hackable. As a result,
the surface language syntax is implemented entirely in macros. This makes the
language both easy to maintain, and easy to extend.

There are three types of macros:

-   Reader Macros: Expanded during parsing, emit am ast
-   Syntax Macros: Expanded after parsing, are passed the ast from the parser
    and produce the final ast
-   Regular Macros: Expanded by a syntax macro

At a high level, the pipeline looks something like this: `file.void -> parser +
reader macros -> syntax macros -> ast (the core language)`

In the next sections, the different macros will be defined in depth.

# Examples

```void
// Translated version of a swift example from https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/

let photos = await taskGroup(of: Optional(Data).self) | () =>
    let photoNames = await listPhotos(inGallery: "Summer Vacation")

    for name in photoNames
        group.addTaskUnlessCancelled (isCancelled) =>
            if not(isCancelled)
                await downloadPhoto(named: name)

    await group.filter() | (photo) => photo != nil

photos.map name =>
    let photo = await downloadPhoto(named: name)
    photo.map(processPhoto)
```
