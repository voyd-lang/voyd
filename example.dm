use std/strings ***

pub fn fib(n:i32) -> i32
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn main() -> void
	let str:String = string "Hello, world!"
	print-str str
