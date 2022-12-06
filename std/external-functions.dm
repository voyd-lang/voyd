use std/macros ***

type String = i32

extern-fn strings alloc-string() -> String

extern-fn strings de-alloc-string(str:String) -> void

extern-fn strings add-char-code-to-string( char:i32 str:String) -> void

extern-fn strings str-len(str:String) -> i32

extern-fn strings printstr(str:String) -> void

// Returns -1 if not found
extern-fn strings get-char-code-from-string(index:i32 str:String) -> i32
