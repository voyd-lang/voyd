
pub fn fib(n:i32) -> i32
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn main() -> i32
	let address:i32 = alloc(4)
	store-i32 address 0 15
	read-i32 address 0
