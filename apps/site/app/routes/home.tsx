import type { Route } from "./+types/home";
import logo from "../../assets/dark-star2.svg";

import { type ReactNode } from "react";
import { Link, useHref } from "react-router";
import { VsxPlayground } from "~/components/VsxPlayground";
import CodeBlock from "~/components/CodeBlock";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Voyd Programming Language" },
    {
      name: "description",
      content:
        "Voyd is a high performance WebAssembly language for full stack web development.",
    },
  ];
}

export default function Home() {
  return (
    <main className="w-full overflow-x-hidden space-y-12">
      <div className="flex flex-col items-center p-4 pb-20">
        <img src={logo} alt="Voyd logo" className="aspect-square w-60" />
        <div className="w-full max-w-2xl space-y-8">
          <div className="w-full space-y-4">
            <h1 className="text-6xl font-bold text-center">voyd</h1>
            <p className="w-full text-xl text-center">
              A high performance WebAssembly programming language with a focus
              on full stack web development.
            </p>
          </div>
          <Links />
        </div>
      </div>
      <VsxExample />
      <Expressive />
    </main>
  );
}

const Expressive = () => {
  const code = `
////////
// Overloads keep functions semantic, no more add_ints and add_floats when the
// parameter types can do the disambiguation for you.
////////

fn add(a: i32, b: i32) = a + b
fn add(a: f64, b: f64) = a + b

add(1, 2) // 3
add(1.0, 2.0) // 3.0

// You can even overload operators!

fn '+'(a: Vec, b: Vec)
  Vec {
    x: a.x + b.x,
    y: a.y + b.y
  }

fn add(a: Vec, b: Vec) = a + b

////////
// Universal function call syntax (UFCS) lets you treat any function like
// a method, so you can call functions with a dot without having to extend objects.
////////

let (a, b) = (Vec { x: 1, y: 2 }, Vec { x: 1, y: 2 })
a.add(b) // Call the add fn defined above with UFCS

////////
// Labeled parameters help make intentions clear, you can even
// specify external and internal labels separately
////////

fn move({ from: Vec, to destination: Vec })
  send_move_instruction_to_robot(from, destination)

move(from: a, to: b)

// Since labeled parameters are just syntax sugar to objects, you can
// pass object literals too. This is handy when you already have an object
// with the parameter fields, or you want to take advantage of object literal
// shorthand so you don't have to repeat yourself

let from = a
let to = b

// Object literal shorthand lets you write:
move({ from, to })

// Instead of
move(from: from, to: to)
`;

  return (
    <Section
      title="Expressive"
      description="Features including (but not limited to) function overloads, labeled parameters, and universal function call syntax make writing maintainable code easy and fun."
    >
      <div className="w-4xl max-w-screen">
        <CodeBlock code={code} />
      </div>
    </Section>
  );
};

const VsxExample = () => {
  const vsxCode = `
use std::all
use std::msgpack::MsgPack
use std::vx::all

fn App()
  let features = ["WASM speed", "Tiny runtime", "Clean syntax"]
  <Card>
    <Title>Voyd + VSX</Title>
    <p style="margin: 0 0 10px 0; color: #cbd5e1;">Build clean UIs in language, no extensions required</p>
    <List value={features} />
  </Card>

fn Title({ children: Array<MsgPack> })
  <h2 style="
    margin: 0 0 8px 0;
    font-size: 20px;
    background: linear-gradient(90deg, #60a5fa, #a78bfa);
    background-clip: text;
    color: transparent;
  ">
    {children}
  </h2>

fn Card({ children: Array<MsgPack> })
  <div style="
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 8px;
    padding: 16px;
    border-radius: 12px;
    background: #0b1020;
    color: #e5e7eb;
    border: 1px solid rgba(255,255,255,0.08);
  ">
    {children}
  </div>

fn List({ value: Array<String> })
  <ul style="margin: 0; padding-left: 16px;">
    {value.map(f => <li style="line-height: 1.6;">{f}</li>)}
  </ul>


pub fn main()
  App()
`;

  return (
    <Section
      title="Built for the web"
      description="voyd includes all the tools you need to build web apps, frontend and backend. Try it out!"
    >
      <div className="w-full md:h-[420px]">
        <VsxPlayground value={vsxCode} />
      </div>
    </Section>
  );
};

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) => {
  return (
    <div className="size-full p-8 flex flex-col items-center space-y-20">
      <Explainer title={title} description={description} />
      {children}
    </div>
  );
};

const Links = () => {
  const stdDocsPath = useHref("/std/");

  return (
    <div className="w-full items-center justify-center flex gap-4 flex-wrap">
      <Link
        to="/docs"
        className="px-4 py-2 rounded-md bg-background-foreground text-text-inverted"
      >
        Read the Docs
      </Link>
      <a
        href="https://github.com/voyd-lang/voyd"
        className="px-4 py-2 rounded-md border border-background-foreground"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
    </div>
  );
};

const Explainer = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => {
  return (
    <div className="w-full space-y-4 max-w-2xl">
      <h1 className="text-4xl font-bold text-center">{title}</h1>
      <p className="w-full text-xl text-center">{description}</p>
    </div>
  );
};
