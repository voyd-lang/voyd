import type { Route } from "./+types/playground";

import { VsxPlayground } from "~/components/VsxPlayground";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Voyd Playground" },
    {
      name: "description",
      content:
        "Try Voyd in the browser with an interactive compiler and VSX renderer.",
    },
  ];
}

const PLAYGROUND_STARTER = `use std::all
use std::msgpack::MsgPack
use std::vx::all

fn App()
  let features = [
    "WASM speed",
    "Strong types",
    "Typed effects",
    "Embeddable runtime"
  ]

  <Card>
    <Title>Voyd Playground</Title>
    <p style="margin: 0 0 12px 0; color: #94a3b8;">Edit and run this file in-browser.</p>
    <List value={features} />
  </Card>

fn Title({ children: Array<MsgPack> })
  <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #e2e8f0;">{children}</h2>

fn Card({ children: Array<MsgPack> })
  <div style="
    margin: 8px;
    padding: 16px;
    border-radius: 12px;
    background: #0b1020;
    color: #e2e8f0;
    border: 1px solid rgba(255, 255, 255, 0.1);
  ">
    {children}
  </div>

fn List({ value: Array<String> })
  <ul style="margin: 0; padding-left: 16px; color: #cbd5e1;">
    {value.map(item => <li style="line-height: 1.6;">{item}</li>)}
  </ul>

pub fn main()
  App()`;

export default function Playground() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-16 pt-6">
      <section className="rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] p-5 sm:p-6">
        <h1 className="m-0 text-3xl font-bold sm:text-4xl">Playground</h1>
        <p className="m-0 mt-3 max-w-3xl text-[var(--site-text-muted)]">
          Run Voyd directly in your browser. The left pane is the editor, and
          the right pane renders the VSX output from your `main` entrypoint.
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
