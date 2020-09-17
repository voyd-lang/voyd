
fn fib(n: i32) -> i32 =
    if n < 2 { n }
    else { fib(n - 1) + fib(n - 2) }

fn main() -> Void = {
    var index = 0
    while index <= 15 {
        index.fib().print()
        index = index + 1
    }
}
