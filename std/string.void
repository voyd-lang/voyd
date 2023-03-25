use std/macros ***

type String = i32

extern-fn strings alloc-string() -> String

extern-fn strings de-alloc-string(str:String) -> void

extern-fn strings str-len(str:String) -> i32

// Returns -1 if not found
extern-fn strings get-char-code-from-string(charIndex:i32 str:String) -> i32

extern-fn strings add-char-code-to-string(char:i32 str:String) -> void

extern-fn strings print-str(str:String) -> void

extern-fn strings str-equals(a:String b:String) -> void

extern-fn strings str-starts-with(str:String startsWith:String) -> void

extern-fn strings str-ends-with(str:String endsWith:String) -> void

extern-fn strings str-includes(str:String includes:String) -> void

// Regex test (pass -1 to flags for default (g))
extern-fn strings str-test(str:String regex:String flags:String) -> void

pub macro string(str)
	let add-codes = str.split("").map (char) =>
		` add-char-code-to-string $(char-to-code char) index
	macro-expand
		` block
			let index:String = alloc-string()
			$@add-codes
			index
