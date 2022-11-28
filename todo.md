- Consider redefining block http://www.lispworks.com/documentation/lw51/CLHS/Body/s_block.htm
- Fix bug in parenthetical elision where an empty list is deleted even when intentional
- Figure out why this doesn't work
  ```
  macro '<|'(&body)
    $@ &body
  ```
- fix nested array weirdness particularly around macro expansion
