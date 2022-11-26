use src/std ***

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
