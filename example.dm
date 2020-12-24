
/** Find the value of the fibonacci sequence at index n */
fn fib(n: i32) -> i32 =
    if n < 2 { n }
    else { fib(n - 1) + fib(n - 2) }

/** All binary programs have a main function */
fn main() -> Void {
    var index = 0
    while index <= 15 {
        // Print fibonacci sequence at index using UFCS. Also supports standard print(fib(index)) syntax.
        index.fib().print()
        index = index + 1
    }
}
