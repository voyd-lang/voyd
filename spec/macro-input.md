# Macro Input

Standard macros receive their arguments in standard S-Expression format. Each supplied argument
is a syntax object that is either a symbol or a list:

```ts
type Symbol = string | number;
type List = Symbol[];
```
