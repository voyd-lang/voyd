# Voyd Style Guide

## Naming

- UpperCamelCase for Types and Components
  - Acronyms should only capitalize the first letter, i.e `HtmlElement`
- snake_case for everything else (including file names)
- Parameters beyond the first two should generally be labeled

## Indentation

Two space indentation. Enforced by the compiler.

**Rational**
This was a tough decision. I really wanted to use tabs, the
first versions even enforced tabs. Unfortunately, in practice,
tabs have two many shortcomings. They are far too large by
default in browsers and terminals (8 spaces) and they are too
uncommon for the primary target market (web development).

I also tried 4 and 3 spaces. 3 was too weird and 4 was too much for
html based components (which is a major feature of the language).
I find I have no difficulty with 2 spaces, and other languages (Nim)
use 2 spaces without issue.

Initially, I found the accessibility argument of tabs compelling. But
I struggled to find any examples of research or testimony that the lack
of tabs posed an accessibility issue in practice.

## Rules of thumb

tldr:
Always prefer obviousness, simplicity and clarity to cleverness.

- Prefer composition to inheritance. Objects should only extend when they
  are conceptually interchangeable with their parent. This does not happen
  often.
- Don't use a macro when a normal function could also work
- Don't use overloads unless the functions conceptually do the same thing.
  This generally means they take the same action, but operate on different types
- Don't over use effects
