import type { Route } from "./+types/home";

import type { ReactNode } from "react";
import { Link } from "react-router";
import CodeBlock from "~/components/CodeBlock";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  const title = "Voyd — One language for the whole web";
  const description =
    "Voyd is a statically typed, WebAssembly-first language for full-stack web applications, with practical effects and a first-party web stack.";

  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:image", content: "https://voyd.dev/og.png" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: "https://voyd.dev/og.png" },
  ];
}

type Feature = {
  id: string;
  number: string;
  label: string;
  title: string;
  description: ReactNode;
  points: { title: string; detail: string }[];
  code: string;
  codeLabel: string;
  lang?: string;
  featured?: boolean;
};

const FEATURES: Feature[] = [
  {
    id: "web-stack",
    number: "01",
    label: "The web stack",
    title: "From route to interface, it’s all Voyd.",
    description: (
      <>
        <code>pkg::web</code> gives you typed routes, request extraction,
        middleware, static files, and server-rendered HTML. In the browser, VX
        brings typed state, messages, and efficient DOM updates. Share models
        and logic without changing languages at every boundary.
      </>
    ),
    points: [
      {
        title: "On the server",
        detail: "Value-returning handlers and typed request data.",
      },
      {
        title: "In the browser",
        detail: "Elm-inspired UI with JSX-like markup.",
      },
      {
        title: "Between them",
        detail: "One type system for shared application logic.",
      },
    ],
    codeLabel: "app.voyd",
    code: `use pkg::web::all
use std::error::HostError
use std::http::server
use std::result::types::all
use std::task
use std::vx::all

pub fn main(): (server::HttpServer, task::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/") do:
      html_response(
        Response::ok(),
        <main>
          <h1>Built with Voyd.</h1>
          <p>One language, front to back.</p>
        </main>
      )`,
  },
  {
    id: "effects",
    number: "02",
    label: "Practical effects",
    title: "Know what your code can do. Skip the ceremony.",
    description: (
      <>
        Think of an effect as a typed capability: permission to call the
        network, read a file, ask the clock, or use an application service. Voyd
        makes those capabilities visible to the compiler, so APIs stay honest
        and tests stay focused. Effects are inferred, and reusable helpers stay
        polymorphic over callback effects—so they don’t force annotation noise
        through the rest of your code. It’s a practical control surface for real
        I/O, not an academic detour.
      </>
    ),
    points: [
      {
        title: "Inferred locally",
        detail: "Ordinary code stays clean and direct.",
      },
      {
        title: "Polymorphic by default",
        detail: "Helpers adopt the effects of their callbacks.",
      },
      {
        title: "Handled at the edge",
        detail: "Production and test hosts provide the capabilities.",
      },
    ],
    codeLabel: "orders.voyd",
    featured: true,
    code: `@effect(id: "app.orders")
eff Orders
  save(tail, order: Order) -> OrderId

fn checkout(order: Order): Orders -> Receipt
  let id = Orders::save(order)
  Receipt { order_id: id }

// The callback's effects are inferred and preserved.
fn run_twice<T>(work: fn() -> T) -> Array<T>
  [work(), work()]`,
  },
  {
    id: "types",
    number: "03",
    label: "A capable type system",
    title: "Types that describe the problem, not the compiler.",
    description: (
      <>
        Combine inference with traits, constrained generics, structural data,
        objects, and precise function types. Voyd is strict where correctness
        matters and expressive where real application code needs room to move.
      </>
    ),
    points: [
      {
        title: "Model invariants",
        detail: "Put domain rules into reusable constraints.",
      },
      {
        title: "Shape exact APIs",
        detail: "Use nominal or structural types as the boundary needs.",
      },
      {
        title: "Refactor with confidence",
        detail: "Catch incompatible changes before runtime.",
      },
    ],
    codeLabel: "repo.voyd",
    code: `trait Persistable
  fn id(self) -> String

obj Repo<T: Persistable> {
  items: Array<T>
}

impl<T: Persistable> Repo<T>
  fn upsert(~self, value: T) -> void
    self.items = self.items.filter(
      item => item.id() != value.id()
    )
    self.items.push(value)`,
  },
  {
    id: "syntax",
    number: "04",
    label: "Designed to be read",
    title: "Code that reads like the idea.",
    description: (
      <>
        Voyd pairs concise expressions with labeled parameters, overloads,
        trailing closures, and uniform function-call syntax. APIs can feel
        natural without hiding control flow or giving up precision.
      </>
    ),
    points: [
      {
        title: "Clear at the call site",
        detail: "Labels explain roles when names alone cannot.",
      },
      {
        title: "Easy to compose",
        detail: "Functions and methods share one consistent model.",
      },
      {
        title: "Low on punctuation",
        detail: "The important parts of the program stand out.",
      },
    ],
    codeLabel: "geometry.voyd",
    code: `fn add(a: i32, b: i32) = a + b
fn add(a: f64, b: f64) = a + b

fn move({ from: Vec, to destination: Vec })
  send_move_instruction(from, destination)

let point = Vec { x: 1, y: 2 }
let moved = point.add(Vec { x: 3, y: 5 })

move(from: point, to: moved)`,
  },
  {
    id: "embedding",
    number: "05",
    label: "Made to embed",
    title: "Put a real language inside your product.",
    description: (
      <>
        Compile Voyd in Node, the browser, or Deno for product extensions,
        sandboxed plugins, and generated programs. WebAssembly provides the
        runtime boundary; your host decides which capabilities the program can
        use.
      </>
    ),
    points: [
      {
        title: "Compile in process",
        detail: "Use the public SDK without a separate toolchain.",
      },
      {
        title: "Bring your own modules",
        detail: "Inject package source for extension systems.",
      },
      {
        title: "Control the boundary",
        detail: "Expose only the host operations your product allows.",
      },
    ],
    codeLabel: "host.ts",
    lang: "typescript",
    code: `import { compile } from "@voyd-lang/sdk/browser";

const result = await compile(source, {
  files: {
    "plugin.voyd": pluginSource,
  },
});

if (!result.success) {
  throw new Error("Plugin compile failed");
}

const wasm = result.module.emitBinary();`,
  },
];

const TOOLING = [
  {
    title: "Test runner",
    detail:
      "Discovery, isolation, structured events, and useful CLI summaries are built in.",
  },
  {
    title: "Documentation",
    detail:
      "Generate HTML or JSON API docs directly from the declarations in your source.",
  },
  {
    title: "Editor tooling",
    detail:
      "Refactors, auto-imports, diagnostics, and more are available in the VS Code extension.",
    href: "https://marketplace.visualstudio.com/items?itemName=voyd-lang.voyd-vscode",
  },
  {
    title: "One public SDK",
    detail:
      "Compile, run, and test through aligned APIs for Node, browsers, and Deno.",
  },
];

export default function Home() {
  return (
    <main className="home-page">
      <Hero />

      <section className="home-features" aria-label="Why Voyd">
        {FEATURES.map((feature, index) => (
          <FeatureSection
            key={feature.id}
            feature={feature}
            reverse={index % 2 === 1}
          />
        ))}
      </section>

      <ToolingSection />
      <FinalCallToAction />
    </main>
  );
}

const Hero = () => {
  return (
    <section className="home-hero">
      <div className="home-hero-glow" aria-hidden="true" />
      <div className="home-hero-inner">
        <p className="home-kicker">A full-stack language for the web</p>
        <h1>Build the whole web without splitting your stack.</h1>
        <p className="home-hero-lede">
          Voyd is a statically typed language that compiles to WebAssembly.
          Write servers, browser apps, and shared logic in one expressive
          language—with practical effects and a first-party web stack.
        </p>
        <div className="home-actions">
          <Link to="/docs" className="home-button home-button-primary">
            Start with Voyd
          </Link>
          <Link to="/playground" className="home-button home-button-secondary">
            Try the playground
          </Link>
        </div>
        <p className="home-proof">
          <span>Open source</span>
          <span>WebAssembly-first</span>
          <span>Type-safe by design</span>
        </p>
      </div>
    </section>
  );
};

const FeatureSection = ({
  feature,
  reverse,
}: {
  feature: Feature;
  reverse: boolean;
}) => {
  return (
    <article
      id={feature.id}
      className={`home-feature ${feature.featured ? "home-feature-featured" : ""}`}
      data-reverse={reverse || undefined}
    >
      <div className="home-feature-copy">
        <p className="home-feature-label">
          <span>{feature.number}</span>
          {feature.label}
        </p>
        <h2>{feature.title}</h2>
        <div className="home-feature-description">{feature.description}</div>
        <dl className="home-feature-points">
          {feature.points.map((point) => (
            <div key={point.title}>
              <dt>{point.title}</dt>
              <dd>{point.detail}</dd>
            </div>
          ))}
        </dl>
      </div>

      <CodePanel
        code={feature.code}
        lang={feature.lang ?? "voyd"}
        label={feature.codeLabel}
      />
    </article>
  );
};

const CodePanel = ({
  code,
  lang,
  label,
}: {
  code: string;
  lang: string;
  label: string;
}) => {
  return (
    <div className="home-code-panel">
      <div className="home-code-header">
        <span aria-hidden="true" className="home-code-dots">
          <i />
          <i />
          <i />
        </span>
        <span>{label}</span>
      </div>
      <CodeBlock code={code} lang={lang} />
    </div>
  );
};

const ToolingSection = () => {
  return (
    <section className="home-tooling">
      <div className="home-tooling-heading">
        <p className="home-kicker">The rest of the job matters, too</p>
        <h2>A language you can use, not just admire.</h2>
        <p>
          Voyd comes with the everyday tools that turn a language into a
          productive workflow.
        </p>
      </div>
      <div className="home-tooling-grid">
        {TOOLING.map((item) => {
          const content = (
            <>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
              {item.href ? <span>Open extension ↗</span> : null}
            </>
          );

          return item.href ? (
            <a
              key={item.title}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="home-tooling-card home-tooling-link"
            >
              {content}
            </a>
          ) : (
            <div key={item.title} className="home-tooling-card">
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
};

const FinalCallToAction = () => {
  return (
    <section className="home-final-cta">
      <p className="home-kicker">See what Voyd feels like</p>
      <h2>One language. Fewer boundaries. Better web software.</h2>
      <p>
        Read the language guide, or open the playground and write your first
        Voyd program now.
      </p>
      <div className="home-actions">
        <Link to="/docs" className="home-button home-button-primary">
          Read the docs
        </Link>
        <a
          href="https://github.com/voyd-lang/voyd"
          target="_blank"
          rel="noopener noreferrer"
          className="home-button home-button-secondary"
        >
          View on GitHub
        </a>
      </div>
    </section>
  );
};
