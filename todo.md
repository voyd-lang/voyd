- Support type aliasing.
- Left off at implementing isExtern function definitions
- Unsafe macros (As add unsafe macro and check safety macros that do a form of "unsafe" checking i.e. rust)
- Fix bug in modules where I can't run syntax macros directly on files within std
- Write up a layout spec defining exactly how parenthetical elision works
- Hygienic macros
- Consider making $() considered to be a block, rather than assuming a
  function call
- Investigate why commas can't separate arguments but can separate array values
- make `;` less necessary. It exists because `=` is greedy. Which I still think is the write move,
  but maybe = should itself be a macro. Reason being, in most cases you want to pass arguments
  to the atom on the right of `=`

  ```
  let x = array.concat
  	definitions.slice(1).map (expr) =>
  		` $expr

  ```

  Here, the definitions expression is meant to be passed along to concat. Instead, it's passed to
  an invisible block that was inserted after the `=`. We could make `=` into a macro that fixes this.
  So you'd no longer need to use a join (`;`):

  ```
  let x = array.concat;
  	definitions.slice(1).map (expr) =>
  		` $expr

  ```

- Make spread of define-function, fn and lambda more consistent. They use a mix of either the last
  is a single expr, or a bunch of expressions
