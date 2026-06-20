import type { Route } from "./+types/playground";

import { VsxPlayground } from "~/components/VsxPlayground";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Voyd Playground" },
    {
      name: "description",
      content:
        "Try Voyd in the browser with an interactive compiler and VX renderer.",
    },
  ];
}

const PLAYGROUND_STARTER = `use std::enums::{ enum }
use std::vx::all

obj Model {
  count: i32
}

enum Msg
  Increment

pub fn app() -> Program<Model, Msg>
  program({ init, update, view })

fn init() -> Model
  Model { count: 0 }

fn update(model: Model, message: Msg) -> Program<Model, Msg>
  match(message)
    Msg::Increment:
      program<Model, Msg>(model: Model { count: model.count + 1 })

fn view(model: Model) -> Html<Msg>
  <main style="
    margin: 8px;
    padding: 16px;
    background: #0b1020;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
  ">
    <h2>Voyd Playground</h2>
    <p>Edit this file, then run it again.</p>
    <section style="
      padding: 14px;
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.12);
    ">
      <p>
        Typed messages update the model in Voyd.
      </p>
      <button
        type="button"
        on_click={Msg::Increment {}}
        style="
          border: 1px solid rgba(125, 211, 252, 0.45);
          padding: 10px 14px;
          background: #0f172a;
          color: #e0f2fe;
          font-weight: 700;
          cursor: pointer;
        "
      >
        Count: {count_label(model.count)}
      </button>
    </section>
  </main>

fn count_label(value: i32) -> String
  if
    value == 0: "0"
    value == 1: "1"
    value == 2: "2"
    value == 3: "3"
    else: "many"`;

export default function Playground() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-16 pt-6">
      <section className="rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] p-5 sm:p-6">
        <h1 className="m-0 text-3xl font-bold sm:text-4xl">Playground</h1>
        <p className="m-0 mt-3 max-w-3xl text-[var(--site-text-muted)]">
          Run Voyd directly in your browser. The left pane is the editor, and
          the right pane renders the VX output from your `view` entrypoint.
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] p-4 sm:p-5">
        <div className="h-[720px] w-full">
          <VsxPlayground value={PLAYGROUND_STARTER} />
        </div>
      </section>
    </main>
  );
}
