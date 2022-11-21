
fn fib(n:i32) -> i32
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn main() -> i32
	fib(10)
