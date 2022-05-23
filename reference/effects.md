# First Class Algebraic Effects

# Examples

## Promises/Async

```
struct Promise(ResolveTyp) {
    var resolve_handlers: Array(Fn(ResolveType) -> void) = $()
    let promise_fn: Fn(resolve: Fn(ResolveType), reject: Fn(RejectType)) -> void

    // Implementation details
    fn then(on_resolve: ResolveType) {
        resolve_handlers.push(on_resolve)
    }
};

effect Async(T) {
    ctrl fn await(prom: Promise(T)) -> T
}

fn wait(time: Int) Async {
    await Promise { resolve =>
        setTimeout(resolve, time)
    }
}

// An async function that handles Async effects by converting them back into a promise
fn async(T)(Fn()) -> Promise(T) {
    with ctrl fn await(prom: Promise(T)) -> T {
        prom.then { val => resume(val) }
    }
}

fn prom_wait(time: Int) -> Promise(Void) async {
    await wait(time)
}
```

## Exceptions

```
effect Exn(T) {
    throw(err: Error) -> Void
    return(val: T) -> Void
}

impl Exn<T> {
    fn try() -> Result<T> = self.han
}
```

## Effect Unions

# TODO

Define effect union syntax.

# Notes

An observation from the Leijen[1] paper:

> A key observation on Moggi’s early work on monads (Moggi, 1991) was that values and computations should be assigned a different type.

The current effect system could be in violation of this principle. Although I'm not certain it is. Koka distinguishes Effect types and value types. While semantically, I believe I do as well, syntactically it doesn't quite look like it.

# References

1. [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/publication/structured-asynchrony-algebraic-effects/)
2. [Koka Manual](https://koka-lang.github.io/koka/doc/kokaspec.html)
