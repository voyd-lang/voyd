use src lib { my-util-function } ; Import my-util-function from src/lib
use src lib { func-a sub-module: { func-b } } ; Import func-a from src/lib and func-b from the submodule in src/lib
use super helpers { func-a: func-c } ; Import func-a as func-c from ../helpers
use @package { pack-func } ; Import pack-func from the installed package called package
use super other-helpers * ; Import everything from ../other-helpers

macro def-wasm-operator(op wasm-fn arg-type return-type)
	fn $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator('<' lt_s i32 i32)
def-wasm-operator('-' sub i32 i32)
def-wasm-operator('+' add i32 i32)

def-wasm-operator('<' lt f32 i32)
def-wasm-operator('-' sub f32 f32)
def-wasm-operator('+' add f32 f32)

fn fib(n:i32) -> i32
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn fib(n:f32) -> f32
	if (n < 2.0)
		n
		fib(n - 1.0) + fib(n - 2.0)

fn main() -> f32
	fib(10.0)
