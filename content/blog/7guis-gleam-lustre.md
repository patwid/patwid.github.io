+++
title = "7GUIs in Gleam and Lustre"
date = 2026-11-27
draft = false
description = "Building the seven tasks of the 7GUIs benchmark with Gleam and Lustre, from a counter to a spreadsheet: phantom types, undo/redo, a small formula language and three tiny FFI files."
tags = ["gleam", "lustre", "7guis", "frontend", "functional-programming"]
+++

I wanted to know what writing a real user interface in
[Gleam](https://gleam.run) feels like, and a to-do app doesn't tell you much.
[7GUIs](https://eugenkiss.github.io/7guis/) by Eugen Kiss is a better test:
seven small tasks, each aimed at a different problem that real interfaces run
into.

1. **Counter**: the basics.
2. **Temperature Converter**: two-way data flow between inputs that depend on
   each other.
3. **Flight Booker**: constraints and validation.
4. **Timer**: concurrency and time.
5. **CRUD**: separating domain logic from presentation, plus a filtered list.
6. **Circle Drawer**: undo/redo, dialogs and custom drawing.
7. **Cells**: a spreadsheet, with parsing, evaluation and change propagation.

I built all seven with [Lustre](https://hexdocs.pm/lustre/), a frontend
framework for Gleam that follows the Elm architecture. The finished tasks run
at [patwid.github.io/7guis](https://patwid.github.io/7guis/), and the source
is on [GitHub](https://github.com/patwid/7guis). This post goes through the
tasks one by one and the parts of each that were worth thinking about.

<!--more-->

## The setup

Each task is its own Gleam module under `src/` with its own `main`. A module
holds a `Model`, a `Msg` type, `init`, `update` and `view`, and nothing else,
so every task is self-contained.

As with [this blog]({{< relref "how-this-blog-is-built.md" >}}), a Nix flake
provides the toolchain (Gleam, Erlang, Bun and Node), and CI builds inside
`nix develop`. A GitHub Actions workflow loops over `src/*.gleam` and builds
each module with Lustre's dev tools:

```sh
for file in src/*.gleam; do
  task=$(basename "$file" .gleam)
  nix develop -c gleam run -m lustre/dev build --minify --outdir="public/$task" "$task"
  nix develop -c sed -i "s|/$task.js|/$repo/$task/$task.js|" "public/$task/index.html"
done
```

The `sed` is there because the generated `index.html` loads its script from
the site root, while a project page on GitHub Pages lives under `/7guis/`. A
plain hand-written `index.html` links the seven pages together.

## Counter

This task needs only Lustre's basic shape. `lustre.simple` takes three pure
functions:

```gleam
pub fn main() {
  let app = lustre.simple(init, update, view)
  let assert Ok(_) = lustre.start(app, "#app", Nil)
  Nil
}

type Msg {
  UserIncrementedCount
}

fn update(model: Model, msg: Msg) -> Model {
  case msg {
    UserIncrementedCount -> model + 1
  }
}
```

Every other task has the same structure, which is the main appeal of the Elm
architecture: once you have read one task, you can read them all.

## Temperature Converter

The spec has a subtle rule: if the user types something that isn't a number
into one field, the other field must not change. So the model has to keep
invalid text around, and I modelled that directly:

```gleam
type Celsius
type Fahrenheit

type Temperature(unit) {
  Number(Int)
  Text(String)
}

type Model =
  #(Temperature(Celsius), Temperature(Fahrenheit))
```

`Celsius` and `Fahrenheit` are *phantom types*. They have no values and exist
only so the compiler can tell the two temperatures apart. A shared
`view_temperature_input` helper is generic over `unit`, so it can render
either field, but it can't pass a Celsius value to a Fahrenheit handler by
mistake. When parsing fails, the field keeps the raw `Text` and gets a red
border.

## Flight Booker

Same idea: a date field is either a parsed `calendar.Date` (from
`gleam_time`) or the raw text the user typed:

```gleam
type Value {
  Date(calendar.Date)
  Text(String)
}
```

Validation is an ordinary function on the model. A one-way flight needs a
valid start date; a return flight needs two valid dates, with the return on or
after the start. The "Book" button's `disabled` attribute is simply
`!is_valid_booking(model)`. The confirmation uses the browser's native
`popover` attribute, so it needs no state in the model and no JavaScript.

## Timer

The Timer is the first task with side effects, so it uses
`lustre.application`, where `init` and `update` also return an `Effect`. The
ticking comes from a one-line FFI binding to `setInterval`, wrapped in an
effect that dispatches a message:

```gleam
fn every(interval: Int, msg: Msg) -> Effect(Msg) {
  effect.from(fn(dispatch) { do_every(interval, fn() { dispatch(msg) }) })
}

@external(javascript, "./timer.ffi.mjs", "every")
fn do_every(interval: Int, cb: fn() -> Nil) -> Nil
```

The model is just `elapsed` and `duration`, both in tenths of a second. The
progress bar and the label are derived from those two numbers, so moving the
duration slider updates everything without extra work.

## CRUD

The domain is a list of people, an optional selected index, the form fields
and a filter prefix. The tricky part is filtering: when the filter hides the
selected person, the selection has to be cleared, otherwise "Update" and
"Delete" would act on a row the user can't see. The `UserUpdatedQuery` branch
of `update` handles that case explicitly.

Updating and deleting split the list at the selected index. `let assert`
documents the invariant that a selection exists and points at a real entry,
and the buttons are disabled whenever it doesn't hold.

## Circle Drawer

This is where the tasks get interesting. Undo/redo is the classic three-part
history:

```gleam
type Model {
  Model(
    past: List(State),
    present: State,
    future: List(State),
    selected: Option(Position),
    dialog: Option(Dialog),
  )
}

type State =
  Dict(Position, Int)
```

The canvas is a `Dict` from circle centre to radius, and immutable data makes
snapshots free. One detail took some care: dragging the radius slider updates
`present` on every input, but the whole drag must be **one** undo step. So the
original radius is stored in the `Slider(Int)` dialog variant, and when the
dialog closes, a single history entry is pushed, and only if the radius
actually changed.

As the spec asks, the circle nearest the cursor is highlighted, and
right-clicking opens a menu for it. The circles are plain SVG elements in the
view.

Modal dialogs needed a trick. A `<dialog>` opens modally through a method call
(`showModal()`), not an attribute, which doesn't fit a declarative view. The
FFI file defines a `modalopen` property on `HTMLDialogElement.prototype` that
calls `showModal()` or `close()` when it is set. The view stays declarative:

```gleam
attribute.property("modalopen", json.bool(model.dialog == Some(Menu)))
```

## Cells

Cells is the largest task, about 1000 of the roughly 2000 lines in total. It
is a 26×100 spreadsheet (columns `A`–`Z`, rows `0`–`99`) with a small formula
language:

```text
42              a number
hello           text
=A1             a reference
=add(A1, B2)    add, sub, mul, div, mod
=sum(A0:A9)     sum and prod over ranges
```

The pipeline is a compiler in miniature. A hand-written recursive-descent
parser turns the raw input into a `Formula` AST:

```gleam
type Formula {
  FEmpty
  FNumber(Float)
  FText(String)
  FRef(CellRef)
  FRange(CellRef, CellRef)
  FCall(String, List(Formula))
}
```

An evaluator reduces the AST to a `Value`: a number, text, empty, or one of
several errors (`ParseError`, `CircularRef`, `TypeError`, `DivByZero`). Errors
propagate through formulas the way spreadsheet users expect, and show up as
`#ERR`, `#CIRC`, `#TYPE` or `#DIV/0`.

Change propagation uses an explicit dependency graph. When a cell is
committed:

1. its references are collected from the AST and stored in `deps`,
2. a depth-first search checks for cycles, so `=A0` in `A0` shows an error
   instead of hanging,
3. the reverse dependencies are built, all transitively affected cells are
   collected, and they are re-evaluated in topological order.

Because everything is pure, each step is a plain function from data to data.
The only JavaScript in this task is a short FFI call that focuses the cell
editor after a double-click.

## Takeaways

- **The Elm architecture scales.** All seven tasks, from Counter to Cells,
  have the same shape. The complexity lives in `update` and in plain helper
  functions, not in the framework.
- **Custom types do most of the work.** Phantom types in the converter,
  `Date | Text` in the flight booker, `Slider(original_radius)` in the circle
  drawer: each time, the right type made the spec's edge cases easy.
- **FFI is a small, clear escape hatch.** Three tiny `.mjs` files (an
  interval, a dialog property and a focus call) were all the JavaScript I
  needed, each wrapped in an `Effect` so `update` stays pure.
- **No exceptions.** Fallible operations return `Result` and have to be
  handled, which pushes you to think about invalid input, and 7GUIs is mostly
  about invalid input.

If you want to get a feel for a GUI framework, 7GUIs is well worth the
weekend. The [Gleam versions](https://patwid.github.io/7guis/) are a click
away.
