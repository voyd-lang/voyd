# voyd_semver

`voyd_semver` is an example publishable Voyd library that provides strict core
semantic-version helpers.

It is intentionally structured as a multi-module package so Voyd `pkg::...`
resolution through `node_modules` can be validated in real consumer scenarios.

## Install

```sh
npm install voyd_semver
```

## Use

```voyd
use pkg::voyd_semver::all

pub fn main() -> i32
  match(parse("1.2.3"))
    Some { value }:
      let next = bump_patch(value)
      if lt(value, next) then:
        1
      else:
        0
    None:
      0
```

## API

- `Version`
- `new_version`
- `parse` (`MAJOR.MINOR.PATCH` only)
- `compare`, `eq`, `lt`, `lte`, `gt`, `gte`
- `bump_major`, `bump_minor`, `bump_patch`
