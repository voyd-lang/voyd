---
order: 220
---

# Structs

Earlier Voyd design notes used `%{ ... }` and `%(... )` syntax for value-type
structs. That syntax is not part of the currently exercised surface language in
the parser/compiler test suite.

Today:

- use tuples for fixed-position values
- use structural objects for named fields
- use nominal objects when the type needs identity or methods

This page remains as a reserved topic rather than a currently supported feature.
