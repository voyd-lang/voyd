# Performance Log

**16 Aug 2025**

Time to parse ~0.19 MB Voyd File (M1 Pro 16GB). Average of 124.68 ms. Relatively
slow. But not terrible considering how flexible the architecture is.

Notes. I played around a but with some minor improvements. Removing most of
the reader macros, leaving only identifier and list macros, had a negligible
impact on performance of parseChars.

The performance of parse chars is actually pretty quick. Its the syntax macros
that slows us down substantially. They are both slow and can only run *after*
the reader macros. Maybe there is a way to merge the two in the future.

```
 ✓ src/parser/__tests__/parser.bench.ts 3131ms
     name                                               hz      min      max     mean      p75      p99     p995     p999     rme  samples
   · parser performance (excluding syntax-macros)  18.9460  49.3119  58.1684  52.7817  54.7330  58.1684  58.1684  58.1684  ±3.66%       10
   · full parser performance                        7.9014   121.93   135.38   126.56   129.88   135.38   135.38   135.38  ±2.58%       10

 ✓ src/parser/__tests__/parser.bench.ts 3131ms
     name                                               hz      min      max     mean      p75      p99     p995     p999     rme  samples
   · parser performance (excluding syntax-macros)  18.9460  49.3119  58.1684  52.7817  54.7330  58.1684  58.1684  58.1684  ±3.66%       10
   · full parser performance                        7.9014   121.93   135.38   126.56   129.88   135.38   135.38   135.38  ±2.58%       10

 BENCH  Summary

  parser performance (excluding syntax-macros) - src/parser/__tests__/parser.bench.ts
    2.40x faster than full parser performance
```
