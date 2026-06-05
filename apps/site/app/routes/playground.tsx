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
use std::string::type::String
use std::vx::all

obj Model {
  local_clicks: i32
}

enum Msg
  Noop

pub fn init() -> Model
  Model { local_clicks: 0 }

pub fn update(model: Model, message: Msg) -> Model
  match(message)
    Msg::Noop:
      model

pub fn view(): Component -> MsgPack
  let (local_count, local_state) = state(id: 1, initial: 0)

  <main style="
    margin: 8px;
    padding: 16px;
    border-radius: 8px;
    background: #0b1020;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
  ">
    <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #e2e8f0;">Voyd Playground</h2>
    <p style="margin: 0 0 14px 0; color: #94a3b8;">Edit this file, then run it again.</p>
    <section style="
      padding: 14px;
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.12);
    ">
      <p style="margin: 0 0 12px 0; color: #cbd5e1;">
        Component-local state updates from a retained event closure.
      </p>
      <button
        type="button"
        on_click={() => local_state.set(local_count + 1)}
        style="
          border: 1px solid rgba(125, 211, 252, 0.45);
          border-radius: 8px;
          padding: 10px 14px;
          background: #0f172a;
          color: #e0f2fe;
          font-weight: 700;
          cursor: pointer;
        "
      >
        Local clicks: {count_label(local_count)}
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
