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

Each task is a Gleam module directly under `src/` with its own `main`. A
module holds a `Model`, a `Msg` type, `init`, `update` and `view`, so every
task is self-contained. The one exception is Cells, which grew large enough to
get helper modules of its own under `src/cells/`, along with unit tests.

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

The glob only matches the top level, so the modules under `src/cells/` are
not mistaken for tasks. The `sed` is there because the generated `index.html`
loads its script from the site root, while a project page on GitHub Pages
lives under `/7guis/`. Making the path relative means the pages work under
any base path. The same loop also collects a link per task, and the script
writes them into a generated `public/index.html` at the end, so adding a task
needs no other change.

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

type Input {
  Empty
  Valid(Float)
  Invalid
}
```

When the user edits one field and it parses as `Valid`, `update` rewrites the
*other* field; on `Empty` or `Invalid` it only stores the new text. The
converted value is rounded to two decimals and loses a zero fraction, so
37 °C reads `98.6` °F and not `98.60000000000001`. The view parses again to
decide which field gets a red border.

I tried wrapping the numbers in `Celsius` and `Fahrenheit` types so the
compiler would catch a conversion in the wrong direction. With only two
one-line conversion functions, each used once, the wrappers guarded against
nothing, and I took them out again.

## Flight Booker

Same idea: the date fields hold the raw text. The only other things in the
model are the selected flight and the booking last made:

```gleam
type Model {
  Model(flight: Flight, start: String, return: String, booked: Option(Booking))
}
```

Any edit clears `booked`, so the confirmation shown below the button always
matches the fields. Validation is a function from the model to a `Checked`
value, which has one variant per flight and holds exactly the fields that
flight uses, each with its date or the reason it has none:

```gleam
type Checked {
  CheckedOneWay(start: Result(Date, Nil))
  CheckedReturn(start: Result(Date, Nil), return: Result(Date, ReturnProblem))
}

type ReturnProblem {
  Unreadable
  BeforeStart
}
```

The types say what can go wrong where: the start date can only be unreadable,
while the return date can also be before the start. Each field is checked on
its own, so the user sees every problem at once, not just the first. An
invalid field turns red and explains its problem in a tooltip.

From `Checked`, a second function derives the booking:

```gleam
type Booking {
  OneWayBooking(date: Date)
  ReturnBooking(start: Date, return: Date)
}

fn booking(checked: Checked) -> Option(Booking)
```

The "Book" button is disabled while `booking` is `None`, and the confirmation
message is formatted from the `Booking` itself, so it can only ever describe a
valid booking.

Both dates start as today's local date. Reading the clock is a side effect, so
`init` doesn't do it: `main` reads the date and passes it to `lustre.start` as
the app's flags, and `init` just receives a `Date`.

## Timer

The Timer is the first task with side effects, so it uses
`lustre.application`, where `init` and `update` also return an `Effect`. The
ticking comes from a binding to `setInterval`, wrapped in an effect that
dispatches a message:

```gleam
fn every(interval: Int, to_msg: fn(Instant) -> Msg) -> Effect(Msg) {
  effect.from(fn(dispatch) {
    do_every(interval, fn(now) { dispatch(to_msg(instant_from_ms(now))) })
  })
}
```

My first version counted ticks: every tick added 100 ms. That is wrong
whenever ticks arrive late, and browsers throttle timers in background tabs
heavily, so the timer fell behind as soon as you looked away. Now each tick
carries the time it fired, read from `performance.now()`, a monotonic clock
that never jumps. The model remembers up to which instant `elapsed` has been
measured, and a tick adds the time that really passed since:

```gleam
type Model {
  Model(elapsed: Duration, duration: Duration, measured_until: Instant)
}
```

`elapsed` is clamped to `duration`, but `measured_until` keeps moving, so if
the user drags the slider up after the timer has filled, it resumes from that
moment rather than jumping ahead. Dragging it below the elapsed time shrinks
`elapsed` with it.

`update` itself never reads the clock. The Reset button decodes the click
event's `timeStamp`, which is on the same clock as the ticks, and the starting
instant is passed in as a flag, as in the flight booker. Because a tick
stamped just before a reset can still arrive after it, a tick never moves
`measured_until` backwards.

## CRUD

The domain is a list of people, an optional selection, the form fields and a
filter prefix. Selecting by list index is tempting, but the index changes
every time the filter does. So each person gets a stable id that is never
reused:

```gleam
type Model {
  Model(
    people: List(Entry),
    next_id: PersonId,
    selected: Option(Entry),
    draft: Person,
    query: String,
  )
}

type Entry {
  Entry(id: PersonId, person: Person)
}
```

The list is kept in creation order, which is also the order it is shown in.
`selected` is a snapshot of the selected entry, not just its id, so there is
no lookup that could fail. It can't go stale either: the people only change
through Create, Update and Delete, and all three clear the selection.

Update and Delete both go through one helper that does nothing without a
selection, so neither can act on a person that isn't selected:

```gleam
fn change_selected(
  model: Model,
  change: fn(People, PersonId) -> People,
) -> Model {
  case model.selected {
    Some(entry) ->
      Model(
        ..model,
        people: change(model.people, entry.id),
        selected: None,
        draft: empty_person,
      )
    None -> model
  }
}
```

The tricky part is filtering: when the filter hides the selected person, the
selection and the form are cleared, otherwise "Update" and "Delete" would act
on a row the user can't see.

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

`history_push` records a new step and drops the redo stack, and
`history_undo` and `history_redo` move between the lists. The circle drawer
stores its list of circles in it, and immutable data makes the snapshots
free.

The interaction state is a small state machine, and each state carries
exactly the data that is meaningful in it:

```gleam
type Interaction {
  Idle
  MenuOpen(target: Entry)
  Adjusting(target: Entry, diameter: Int)
}
```

An open menu or dialog always refers to a circle, and the menu can't be open
while the diameter dialog is. `update` dispatches on the interaction first,
with one function per state, and each of them lists every message it ignores
by name instead of using a catch-all. When I add a message, the compiler makes
me decide what it means in each state.

The diameter dialog must change the circle live while the slider is dragged,
but the whole drag must be **one** undo step. The `diameter` in `Adjusting`
solves this: it is a preview, and the view draws the target circle with it.
The history isn't touched until the dialog closes, at which point the new
diameter is pushed as a single step, and only if it actually changed.

The highlighted circle is not stored at all. The model keeps the pointer
position, and the view derives the circle nearest to it. While a menu or
dialog is open, the highlight is on their target instead, and when they close,
the circle under the pointer lights up again straight away.

Modal dialogs needed a trick. A `<dialog>` opens modally through a method call
(`showModal()`), not an attribute, which doesn't fit a declarative view. The
FFI file defines a `modalopen` property on `HTMLDialogElement.prototype` that
calls `showModal()` or `close()` when it is set. The view stays declarative:

```gleam
attribute.property("modalopen", json.bool(open))
```

The browser can also close a modal dialog on its own, for example on Escape.
If the model didn't notice, it would stay in a state that ignores every click
on the canvas. So both dialogs listen for the native `close` event and turn it
into a message. Closing a dialog by clicking its backdrop is a custom event
decoder: it only produces a message when the click's target is the dialog
element itself, not something inside it.

## Cells

Cells is the largest task, about 1100 of the roughly 2600 lines in total. It
is a 26×100 spreadsheet (columns `A`–`Z`, rows `0`–`99`) with a small formula
language:

```text
42              a number
hello           text
=A1             a reference
=add(A1, B2)    add, sub, mul, div, mod
=sum(A0:A9)     sum and prod over ranges
```

It is split into the Lustre app in `cells.gleam` and three modules underneath
it, each hiding its details behind a small interface:

- `cell_ref` defines `CellRef` as an opaque type. The only ways to get one
  are a constructor and a parser that both check the bounds, and functions
  like `next` that stay in range, so every `CellRef` lies inside the sheet.
- `formula` is the expression language: its types, a parser and the set of
  cells an expression reads.
- `sheet` is the spreadsheet itself: cell contents, their values and the
  dependencies between them, behind an opaque `Sheet`.

A hand-written recursive-descent parser turns a formula into an `Expr`:

```gleam
type Expr {
  Literal(Float)
  Ref(CellRef)
  Binary(BinOp, Expr, Expr)
  Aggregate(AggOp, List(Arg))
}

type Arg {
  Single(Expr)
  Range(CellRef, CellRef)
}
```

The types encode the grammar. `add` and friends take exactly two operands, so
they become a `Binary`, and the parser rejects `=add(1)` or `=add(1, 2, 3)`
instead of building a call the evaluator would have to check. A range like
`A0:A9` only makes sense as an argument to `sum` or `prod`, so it is an `Arg`,
not an `Expr`, and neither `=A0:A9` on its own nor `=add(A0:A9, 1)` can even
be represented. `BinOp` and `AggOp` are closed types rather than strings, so
the evaluator's `case` over them is checked for exhaustiveness.

The evaluator reduces an expression to a `Value`: a number, text, or one of
several errors (`ParseError`, `CircularRef`, `TypeError`, `DivByZero`).
Errors propagate through formulas the way spreadsheet users expect, and show
up as `#ERR`, `#CIRC`, `#TYPE` or `#DIV/0`. A blank cell has no value at all,
and a formula that reads one sees `0`, as in other spreadsheets.

The `Sheet` keeps three dictionaries: the parsed cells, their evaluated
values, and the inverse of the dependency graph, i.e. which cells read each
cell. When a cell is set, the sheet updates the graph and then recalculates:

1. it collects every cell that transitively depends on the changed one,
2. it splits those cells into strongly connected components with
   [Tarjan's algorithm](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm),
   which finds every reference cycle in a single depth-first search and
   returns the components in dependency order as a bonus,
3. cells in a cycle get a `CircularRef` error, so `=A0` in `A0` shows
   `#CIRC` instead of hanging, and all other cells are re-evaluated in order.
   Cells that depend on a cycle pick the error up through normal evaluation.

Because everything is pure, each step is a plain function from data to data,
and the modules are easy to unit test without a browser.

Editing works the way you'd expect: double-click a cell, then Enter commits,
Escape cancels, and Tab or Shift-Tab commits and moves on to the next or
previous cell. Clicking elsewhere commits too, which needed some care: after a
Tab, the old cell's input loses focus only once the next cell's editor is
already open. So the blur message carries the cell it came from, and only
closes the editor if that cell is still the one being edited. The only
JavaScript in this task is a short FFI call that focuses the cell editor.

## Takeaways

- **The Elm architecture scales.** All seven tasks, from Counter to Cells,
  have the same shape. The complexity lives in `update` and in plain helper
  functions, not in the framework.
- **Keep what the user typed, derive the rest.** The converter and the flight
  booker store raw text and parse on demand, and the circle drawer derives the
  highlighted circle from the pointer. Nothing gets reformatted while typing,
  and nothing derived can go stale because it isn't stored.
- **Custom types do most of the work.** `Checked` in the flight booker,
  `Interaction` in the circle drawer, `Binary` and `Arg` in the spreadsheet:
  each time, the right type made invalid states impossible to represent and
  the spec's edge cases easy. But a type has to rule something out to earn
  its place, which the temperature units didn't.
- **Keep `update` pure.** Today's date and the timer's start come in as
  flags, and the timer's clock readings ride on the messages. Side effects
  stay in `main` and in effects.
- **FFI is a small, clear escape hatch.** Three tiny `.mjs` files (an
  interval and a clock, a dialog property and a focus call) were all the
  JavaScript I needed.
- **No exceptions.** Fallible operations return `Result` and have to be
  handled, which pushes you to think about invalid input, and 7GUIs is mostly
  about invalid input.

If you want to get a feel for a GUI framework, 7GUIs is well worth the
weekend. The [Gleam versions](https://patwid.github.io/7guis/) are a click
away.
