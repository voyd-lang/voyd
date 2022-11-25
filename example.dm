macro def-wasm-operator(op wasm-fn arg-type return-type)
	fn $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator('<' lt_s i32 i32)
def-wasm-operator('-' sub i32 i32)
def-wasm-operator('+' add i32 i32)

fn fib(n:i32) -> i32
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn main() -> i32
	fib(10)
