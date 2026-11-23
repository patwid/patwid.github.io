+++
title = "7GUIs in Gleam and Lustre"
date = 2026-11-27
draft = false
description = "Building the seven tasks of the 7GUIs benchmark with Gleam and Lustre, from a counter to a spreadsheet: keeping raw input in the model, state machines as custom types, a generic undo history, a small formula language and three tiny FFI files."
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
framework for Gleam that follows the Elm architecture. The finished tasks
[run in the browser](https://patwid.github.io/7guis/), and the source
is on [GitHub](https://github.com/patwid/7guis). This post goes through the
tasks one by one and the parts of each that were worth thinking about.

<!--more-->

## The setup

Each task is its own Gleam module under `src/` with its own `main`. A module
holds a `Model`, a `Msg` type, `init`, `update` and `view`, and nothing else,
so every task is self-contained.

As with [this blog]({{< relref "how-this-blog-is-built.md" >}}), a Nix flake
provides the toolchain (Gleam, Erlang, Bun and Node), and CI runs a single
`nix develop -c ./scripts/build.sh`. The script loops over `src/*.gleam` and
builds each module with Lustre's dev tools:

```sh
for file in src/*.gleam; do
  task=$(basename "$file" .gleam)
  gleam run -m lustre/dev build --minify --outdir="$out/$task" "$task"
  sed -i "s|src=\"/$task\.js\"|src=\"$task.js\"|" "$out/$task/index.html"
done
```

The `sed` is there because the generated `index.html` loads its script from
the site root, while a project page on GitHub Pages lives under `/7guis/`.
Making the path relative means the pages work under any base path. The same
loop also collects a link per task, and the script writes them into a
generated `public/index.html` at the end, so adding a task needs no other
change.

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
into one field, the other field must not change. A second, unwritten rule is
just as important: the field the user is typing into must never be
reformatted under their cursor.

Both rules point the same way. The model stores the text of both fields
exactly as shown, and numbers are parsed from it on demand:

```gleam
type Model {
  Model(celsius: String, fahrenheit: String)
}

type Celsius {
  Celsius(Int)
}

type Fahrenheit {
  Fahrenheit(Int)
}

type Input(a) {
  Empty
  Valid(a)
  Invalid
}
```

`parse` takes the unit's constructor as an argument, so
`parse(text, Celsius)` returns an `Input(Celsius)`. The conversion functions
take a `Celsius` and return a `Fahrenheit` and vice versa, so the compiler
won't let me convert in the wrong direction. When the user edits one field
and it parses as `Valid`, `update` rewrites the *other* field; on `Empty` or
`Invalid` it only stores the new text. The view parses again to decide which
field gets a red border.

## Flight Booker

Same idea: the date fields hold the raw text, and the model has no notion of
validity at all:

```gleam
type Model {
  Model(flight: Flight, start: String, return: String)
}
```

Validation is a function that tries to derive a `Booking` from the model:

```gleam
type Booking {
  OneWayBooking(date: Date)
  ReturnBooking(start: Date, return: Date)
}

fn booking(model: Model) -> Result(Booking, Nil)
```

A one-way flight needs a valid start date; a return flight needs two valid
dates, with the return on or after the start. Dates are parsed with
`gleam_time`. The "Book" button is disabled when `booking(model)` is an
error, and the confirmation message is formatted from the `Booking` itself,
so it can only ever describe a valid booking. It is shown with the browser's
native `popover` attribute, which needs no state in the model and no
JavaScript.

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

The model is just `elapsed` and `duration`, both `Duration` values from
`gleam_time` rather than bare integers. A tick only advances `elapsed` while
it is below `duration`, and clamps it there. If the user drags the slider
below the elapsed time, the view shows the shorter duration as full; drag it
back up and the timer continues from where it was. The progress bar and the
label are derived from those two values, so the slider updates everything
without extra work.

## CRUD

The domain is a set of people, an optional selection, the form fields and a
filter prefix. Selecting by list index is tempting, but the index changes
every time the filter does. So each person gets a stable id:

```gleam
type Model {
  Model(
    people: Dict(PersonId, Person),
    next_id: Int,
    selected: Option(PersonId),
    draft: Person,
    query: String,
  )
}
```

Ids increase monotonically, so sorting by id also gives the insertion order
for the list. The tricky part is filtering: when the filter hides the
selected person, the selection has to be cleared, otherwise "Update" and
"Delete" would act on a row the user can't see.

`update` matches on the message and the selection together, so updating and
deleting can only happen when there is something selected:

```gleam
case msg, model.selected {
  UserUpdatedPerson, Some(id) -> ...
  UserDeletedPerson, Some(id) -> ...
  ...
  // Update and delete need a selection; the buttons are disabled otherwise.
  UserUpdatedPerson, None | UserDeletedPerson, None -> model
}
```

## Circle Drawer

This is where the tasks get interesting. Two things needed real modelling:
the undo history and the interaction state.

Undo/redo is the classic three-part history. Since it doesn't care what it
stores, it is a generic type with a handful of functions:

```gleam
type History(a) {
  History(past: List(a), present: a, future: List(a))
}
```

`history_push` records a new step and drops the redo stack,
`history_replace` changes the present without recording a step, and
`history_undo` and `history_redo` move between the lists. The circle drawer
stores a `Dict(CircleId, Circle)` in it, and immutable data makes snapshots
free.

The interaction state is a small state machine, and each state carries
exactly the data that is meaningful in it:

```gleam
type Interaction {
  Idle(hovered: Option(CircleId))
  MenuOpen(circle: CircleId)
  Adjusting(circle: CircleId, original_diameter: Int)
}
```

An open dialog always refers to a circle, and the menu can't be open while
the diameter dialog is. `update` matches on the message and the interaction
together and ignores every combination that makes no sense, such as hovering
while a modal dialog is open.

`Adjusting` carries `original_diameter` for a reason. Dragging the diameter
slider updates the present state on every input via `history_replace`, so the
circle grows and shrinks live. But the whole drag must be **one** undo step.
When the dialog closes, the present state is reset to the original diameter
and the new one is pushed as a single history entry, and only if the
diameter actually changed.

As the spec asks, the circle nearest the cursor is highlighted, and
right-clicking opens a menu for it. The circles are plain SVG elements in the
view.

Modal dialogs needed a trick. A `<dialog>` opens modally through a method call
(`showModal()`), not an attribute, which doesn't fit a declarative view. The
FFI file defines a `modalopen` property on `HTMLDialogElement.prototype` that
calls `showModal()` or `close()` when it is set. The view stays declarative:

```gleam
attribute.property("modalopen", json.bool(open))
```

Closing a dialog by clicking its backdrop is a custom event decoder: it only
produces a message when the click's target is the dialog element itself, not
something inside it.

## Cells

Cells is the largest task, about 870 of the roughly 2000 lines in total. It
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
parser turns the raw input into a `Content`:

```gleam
type Content {
  Blank
  Number(Float)
  Text(String)
  Formula(Expr)
  Malformed
}

type Expr {
  Literal(Float)
  Ref(CellRef)
  Call(Function, List(Arg))
}

type Arg {
  Single(Expr)
  Range(CellRef, CellRef)
}
```

The types encode the grammar. A range like `A0:A9` only makes sense as a
function argument, so it is an `Arg`, not an `Expr`, and `=A0:A9` on its own
can't even be represented. Functions are a closed `Function` type rather than
strings, so the evaluator's `case` over them is checked for exhaustiveness.

The evaluator reduces an `Expr` to a `Value`: a number, text, empty, or one
of several errors (`ParseError`, `CircularRef`, `TypeError`, `DivByZero`).
Errors propagate through formulas the way spreadsheet users expect, and show
up as `#ERR`, `#CIRC`, `#TYPE` or `#DIV/0`.

Each non-blank cell stores its raw text, the parsed content and the evaluated
value as a cache:

```gleam
type Cell {
  Cell(raw: String, content: Content, value: Value)
}
```

When a cell is committed, `recalculate` keeps those caches up to date:

1. the dependency graph is built from the references in each formula, and
   inverted to find every cell that transitively depends on the changed one,
2. any affected cell that lies on a reference cycle gets a `CircularRef`
   error, so `=A0` in `A0` shows `#CIRC` instead of hanging,
3. the remaining cells are re-evaluated in topological order. Cells that
   depend on a cycle pick the error up through normal evaluation.

Because everything is pure, each step is a plain function from data to data.
Editing works the way you'd expect: double-click a cell, then Enter commits,
Escape cancels, and Tab or Shift-Tab commits and moves on to the next or
previous cell. The only JavaScript in this task is a short FFI call that
focuses the cell editor.

## Takeaways

- **The Elm architecture scales.** All seven tasks, from Counter to Cells,
  have the same shape. The complexity lives in `update` and in plain helper
  functions, not in the framework.
- **Keep what the user typed, derive the rest.** The converter and the flight
  booker store raw text and parse on demand. Nothing gets reformatted while
  typing, and validity can never go stale because it isn't stored.
- **Custom types do most of the work.** `Booking` in the flight booker,
  `Interaction` in the circle drawer, `Arg` in the spreadsheet: each time,
  the right type made invalid states impossible to represent and the spec's
  edge cases easy.
- **FFI is a small, clear escape hatch.** Three tiny `.mjs` files (an
  interval, a dialog property and a focus call) were all the JavaScript I
  needed, each wrapped in an `Effect` so `update` stays pure.
- **No exceptions.** Fallible operations return `Result` and have to be
  handled, which pushes you to think about invalid input, and 7GUIs is mostly
  about invalid input.

If you want to get a feel for a GUI framework, 7GUIs is well worth the
weekend. The [Gleam versions](https://patwid.github.io/7guis/) are a click
away.
