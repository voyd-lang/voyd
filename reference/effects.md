# First Class Algebraic Effects

# Examples

## Promises/Async

```
effect Promise<T> {
    case start(initiator: Fn [
        resolve: Fn(val: T) -> Void,
        reject: Fn(err: Error) -> Void
     ] -> Void) -> T

    case await<U>(prom: Promise<U>) -> U

    case return(val: T) -> Void
}

impl Promise<T> {
    static fn resolve(val: T) = Promise<T> {
        start { resolve, _ => resolve(val) }
    }

    pub fn then(cb: Fn(result: Result<T>) -> Void) -> Void = self.handle {
        start(initiator) => initiator[
            resolve: val => resume(val),
            reject: err => cb(Err(err))
        ],

        await(prom) => prom.then { result =>
            result.match {
                Ok(val) => resume(val),
                Err(err) => cb(Err(err))
            }
        },

        return(val) => cb(Ok(val))
    }
}

fn wait(time: Int) = Promise<Void> {
    start { resolve, _ => setTimeout(_ => resolve(Void()), time) }
}

fn say_things() = Promise<Void> {
    print "Hello!"
    await wait(3000)
    print "Hello!"
}

fn main() = {
    say_things.then { result =>
        result.match {
            Ok(_) => print "Done!",
            Err(_) => print "Oops!"
        }
    }
}
```

## Exceptions

```
effect Exn<T> {
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
