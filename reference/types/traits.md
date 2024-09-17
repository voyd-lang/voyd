# Traits

Traits are first class types that define the behavior of a nominal object.

```void
trait Run
  fn run(self) -> String
  fn stop(&self) -> void

obj Car {
  speed: i32
}

impl Run for Car
  fn run(self) -> String
    "Vroom!"

  fn stop(&self) -> void
    self.speed = 0

let car = Car { speed: 10 }
log car.run() // "Vroom!"
&car.stop()

car can Run // true

// Because traits are first class types, they can be used to define parameters
// that will accept any type that implements the trait
fn run_thing(thing: Run) -> void
  log thing.run()

run_thing(car) // Vroom!
```

## Default Implementations

Status: Not yet implemented

Traits can specify default implementations which are automatically applied
on implementation, but may still be overridden by that impl if desired

```void
trait One
  fn one() -> i32
    1
```

## Trait Requirements

Status: Not yet implemented

Traits can specify that implementors must also implement other traits:

```void
trait DoWork requires: This & That
```

## Trait limitations

Traits must be in scope to be used. If the `Run` trait were defined
in a different file (or module), it would have to be imported before its
methods could be used

```void
car.run() // Error, no function found for run

use other_file::{ Run }

car.run() // Vroom!
```

Trait implementations cannot have overlapping target types:

```void
obj Animal {}
obj Dog {}

trait Speak
  fn speak() -> void

impl Speak for Animal
  fn speak()
    log "Glub glub"

impl Speak for Dog // ERROR: Speak is already implemented for Dog via parent type Animal
```
