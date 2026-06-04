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

const PLAYGROUND_STARTER = `use std::all
use std::dict::Dict
use std::msgpack::MsgPack
use std::msgpack::self as msgpack
use std::result::types::all
use std::vx::all

pub fn init() -> MsgPack
  model(count: 0)

pub fn update(current: MsgPack, message: MsgPack) -> MsgPack
  model(count: count_from(current) + 1)

pub fn view(model: MsgPack) -> MsgPack
  <Card>
    <Title>Voyd Playground</Title>
    <p style="margin: 0 0 14px 0; color: #94a3b8;">Edit this file, then run it again.</p>
    <Counter label="Count" value={count_from(model)} />
  </Card>

fn Title({ children: Array<MsgPack> })
  <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #e2e8f0;">{children}</h2>

fn Card({ children: Array<MsgPack> })
  <div style="
    margin: 8px;
    padding: 16px;
    border-radius: 8px;
    background: #0b1020;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
  ">
    {children}
  </div>

fn Counter({ label: String, value: i32 })
  <Panel>
    <p style="margin: 0 0 12px 0; color: #cbd5e1;">
      App state keeps this counter alive between renders.
    </p>
    <button
      type="button"
      on_click={msgpack::make_string("increment")}
      style="
        border: 0;
        border-radius: 8px;
        padding: 10px 14px;
        background: #38bdf8;
        color: #082f49;
        font-weight: 700;
        cursor: pointer;
      "
    >
      {label}: {count_label(value)}
    </button>
  </Panel>

fn Panel({ children: Array<MsgPack> })
  <section style="
    padding: 14px;
    border-radius: 8px;
    background: rgba(148, 163, 184, 0.12);
  ">
    {children}
  </section>

fn count_from(value: MsgPack) -> i32
  match(msgpack::unpack_map(value))
    Ok<Dict<String, MsgPack>> { value }:
      match(value.get("count"))
        Some<MsgPack> { value }:
          match(msgpack::unpack_i32(value))
            Ok<i32> { value }:
              value
            Err:
              0
        None:
          0
    Err:
      0

fn count_label(value: i32) -> String
  if
    value == 0: "0"
    value == 1: "1"
    value == 2: "2"
    value == 3: "3"
    else: "many"

fn model({ count: i32 }) -> MsgPack
  let ~out = Dict<String, MsgPack>::init()
  out.set("count", msgpack::make_i32(count))
  msgpack::make_map(out)`;

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
