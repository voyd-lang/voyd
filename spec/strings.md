# Strings

There are two types of strings in dream. String literals and string atoms. String atoms are
just like any other atom and can be used to define identifiers with spaces. The are defined between
single quotes. String literals are defined in between double quotes and act as a standard string
i.e. javascript string.

Note: Unlike common lisp, the single quote is not a macro for `quote`. Only the backtick.

> Second, one might wonder what happens if a backquote expression occurs inside another backquote. The answer is that the backquote becomes essentially unreadable and unwriteable; using nested backquote is usually a tedious debugging exercise. The reason, in my not-so-humble opinion, is that backquote is defined wrong. A comma pairs up with the innermost backquote when the default should be that it pairs up with the outermost. But this is not the place for a rant; consult your favorite Lisp reference for the exact behavior of nested backquote plus some examples.
> https://lisp-journey.gitlab.io/blog/common-lisp-macros-by-example-tutorial/

Dream follows the suggestion of this website and pairs commas with the outermost backquote. Which allows
one to use a backquote where a quote would normally be needed.

## String atom

String atoms are just like any other atom and can be used to define identifiers with spaces. They
are also useful for defining operator overloads.

### Syntax

```
'i can be used as an identifier`
```

## String literal

```
"i can be manipulated and printed and am not evaluated like as an atom"
```
