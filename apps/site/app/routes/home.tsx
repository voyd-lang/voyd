import type { Route } from "./+types/home";

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import CodeBlock from "~/components/CodeBlock";

export const prerender = true;

export function meta({}: Route.MetaArgs) {
  const title = "Voyd Programming Language";
  const description =
    "Voyd is a statically typed language that compiles to WebAssembly, with typed effects and a full-stack web framework.";

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
};

type HeroStar = {
  left: number;
  top: number;
  thickness: number;
  length: number;
  opacity: number;
  delay: number;
  duration: number;
  angle: number;
  travelX: number;
  travelY: number;
};

const FEATURES: Feature[] = [
  {
    id: "web-stack",
    number: "01",
    label: "The web stack",
    title: "Designed for full-stack web",
    description: (
      <>
        Voyd includes typed routes, request extraction, middleware, static
        files, and server-rendered HTML. VX uses a typed model, message, and
        update loop for browser interfaces, and renders the same virtual tree on
        the server. Application models and logic can be shared across both.
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
use std::task::self as tasks
use std::vx::all

fn home() -> Response
  html_response<Unit>(
    Response::ok(),
    <main>
      <h1>Built with Voyd.</h1>
      <p>One language, front to back.</p>
    </main>
  )

pub fn main(): (server::HttpServer, tasks::TaskRuntime) -> Result<Unit, HostError>
  serve(port: 3000) routes():
    get("/") do:
      home()`,
  },
  {
    id: "effects",
    number: "02",
    label: "Effects",
    title: "Type-check side effects, too",
    description: (
      <>
        A strong data type system catches mistakes in values and interfaces.
        Voyd’s effect system also tracks what functions can do, such as reading
        a file, calling a service, or using the clock, and checks that those
        effects are handled. Effect rows are inferred and polymorphic, so
        higher-order code remains reusable without passing annotations through
        every layer.
      </>
    ),
    points: [
      {
        title: "Catch more at compile time",
        detail: "Required capabilities stay visible in public APIs.",
      },
      {
        title: "Inferred, not threaded",
        detail: "Most local code does not need effect annotations.",
      },
      {
        title: "Test with handlers",
        detail: "Replace I/O at the boundary without reshaping domain code.",
      },
    ],
    codeLabel: "orders.voyd",
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
    label: "Types",
    title: "A strong, expressive type system",
    description: (
      <>
        Voyd combines local inference with traits, constrained generics,
        structural data, objects, and precise function types. These tools make
        it possible to describe application invariants without adding type
        annotations to every expression.
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
    codeLabel: "models.voyd",
    code: `fn ids(items: Array<{ id: String }>) -> Array<String>
  items.map(item => item.id)`,
  },
  {
    id: "syntax",
    number: "04",
    label: "Syntax",
    title: "Clear, modern syntax",
    description: (
      <>
        Voyd pairs concise expressions with labeled parameters, overloads,
        trailing closures, and uniform function-call syntax. The goal is to make
        APIs readable while keeping control flow explicit.
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
    label: "Embedding",
    title: "Embeddable by design",
    description: (
      <>
        Voyd can be compiled from Node, the browser, or Deno for extensions,
        sandboxed plugins, and generated programs. WebAssembly provides the
        runtime boundary, while the host decides which capabilities are
        available.
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

const source = \`use src::plugin::all

pub fn main() -> i32
  answer()\`;

const result = await compile(source, {
  files: {
    "plugin.voyd": \`pub fn answer() -> i32
  42\`,
  },
});

if (!result.success) {
  throw new Error("Plugin compile failed");
}

const wasm = result.module.emitBinary();`,
  },
];

const HERO_STARS: HeroStar[] = Array.from({ length: 220 }, (_, index) => {
  const left = (index * 37.71 + 3) % 100;
  const top = (index * 61.37 + 7) % 100;
  const offsetX = left - 50;
  const offsetY = top - 50;
  const screenOffsetX = offsetX * 1.9;
  const distance = Math.hypot(screenOffsetX, offsetY) || 1;
  const travel = 110 + (index % 7) * 28;
  const large = index % 19 === 0;
  const medium = !large && index % 7 === 0;

  return {
    left,
    top,
    thickness: large ? 1.8 : medium ? 1.2 : 0.8,
    length: large ? 25 : medium ? 17 : 10 + (index % 3) * 2,
    opacity: large ? 0.9 : medium ? 0.72 : 0.42 + (index % 4) * 0.08,
    delay: -((index * 1.43) % 19),
    duration: 10 + (index % 8) * 1.6,
    angle: (Math.atan2(offsetY, screenOffsetX) * 180) / Math.PI,
    travelX: (screenOffsetX / distance) * travel,
    travelY: (offsetY / distance) * travel,
  };
});

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
      <div className="home-black-hole" aria-hidden="true">
        <HeroStars />
        <div className="home-hero-backdrop" />
      </div>
      <div className="home-hero-inner">
        <h1>Voyd</h1>
        <p className="home-hero-lede">
          Voyd is a statically typed language that compiles to WebAssembly.
          Write servers, browser apps, and shared logic in one expressive
          language—with practical effects and a first-party web stack.
        </p>
        <div className="home-actions">
          <Link to="/docs" className="home-button home-button-primary">
            Getting Started
          </Link>
          <Link to="/playground" className="home-button home-button-secondary">
            Try the playground
          </Link>
        </div>
      </div>
    </section>
  );
};

const HeroStars = () => {
  return (
    <div className="home-stars">
      {HERO_STARS.map((star, index) => (
        <span
          key={index}
          style={
            {
              "--home-star-left": `${star.left}%`,
              "--home-star-top": `${star.top}%`,
              "--home-star-thickness": `${star.thickness}px`,
              "--home-star-length": `${star.length}px`,
              "--home-star-opacity": star.opacity,
              "--home-star-delay": `${star.delay}s`,
              "--home-star-duration": `${star.duration}s`,
              "--home-star-angle": `${star.angle}deg`,
              "--home-star-travel-x": `${star.travelX}px`,
              "--home-star-travel-y": `${star.travelY}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
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
      className="home-feature"
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
        <p className="home-kicker">Tooling</p>
        <h2>Batteries included</h2>
        <p>
          Voyd includes the everyday tools needed to build, test, document, and
          maintain a project.
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
      <h2>Explore Voyd</h2>
      <p>
        Read the language guide, try the playground, or explore the compiler and
        standard library on GitHub.
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
