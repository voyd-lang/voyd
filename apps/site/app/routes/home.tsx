import type { Route } from "./+types/home";

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
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

type Feature = {
  id: string;
  title: string;
  description: string;
  points: string[];
  code: string;
  lang?: string;
};

const CORE_FEATURES: Feature[] = [
  {
    id: "full-stack",
    title: "Designed for full stack web",
    description:
      "Ship backend handlers, shared domain logic, and frontend views with one language model and one type system.",
    points: [
      "Compile to WebAssembly for browser, server, edge, and worker runtimes.",
      "Keep API contracts and UI model types aligned across the stack.",
      "Compose by modules and package exports, not framework magic.",
    ],
    code: `use src::web::routes::all
use src::web::ui::all

pub fn main() -> void
  let app = WebApp::new()
  app.route("GET", "/", handler: render_home)
  app.route("GET", "/api/projects", handler: list_projects)
  app.listen(port: 8080)

fn render_home() -> Html
  render(HomePage {})`,
  },
  {
    id: "types",
    title: "Strong type system",
    description:
      "Nominal and structural constraints, generics, and compile-time effect checking keep large systems predictable.",
    points: [
      "Use constrained generics to codify invariants early.",
      "Model precise APIs with traits, objects, and type aliases.",
      "Catch mismatch errors before runtime.",
    ],
    code: `trait Persistable
  fn id(self) -> String

obj Repo<T: Persistable> {
  items: Array<T>
}

impl<T: Persistable> Repo<T>
  fn upsert(~self, value: T) -> void
    self.items = self.items.filter(item => item.id() != value.id())
    self.items.push(value)`,
  },
  {
    id: "syntax",
    title: "Elegant syntax",
    description:
      "Readable defaults, labeled parameters, UFCS, and overloads help code stay expressive without losing precision.",
    points: [
      "Write APIs that read like intent, not plumbing.",
      "Overload where semantics match; keep names stable.",
      "Use UFCS for composable data transforms.",
    ],
    code: `fn add(a: i32, b: i32) = a + b
fn add(a: f64, b: f64) = a + b

fn move({ from: Vec, to destination: Vec })
  send_move_instruction(from, destination)

let point = Vec { x: 1, y: 2 }
let moved = point.add(Vec { x: 3, y: 5 })
move(from: point, to: moved)`,
  },
  {
    id: "effects",
    title: "Effects",
    description:
      "Effects are typed and resumable, so you can express async behavior and host interactions without sacrificing safety.",
    points: [
      "Effect rows make side effects visible in signatures.",
      "Handle effects locally with `try` clauses.",
      "Keep pure APIs pure and explicit.",
    ],
    code: `eff Async
  await(tail) -> i32
  resolve(resume, value: i32) -> void
  reject(resume, msg: String) -> void

fn load_count(): Async -> i32
  let value = Async::await()
  if value > 0 then:
    Async::resolve(value)
  else:
    Async::reject("Expected positive count")

fn main(): () -> i32
  try
    load_count()
  await(tail):
    tail(42)
  resolve(resume, value):
    value
  reject(resume, msg):
    0`,
  },
  {
    id: "embeddable",
    title: "Embeddable",
    description:
      "Use Voyd as a runtime for product extensions, sandboxed plugins, or AI-generated routines while keeping host control.",
    points: [
      "Compile in-process with the SDK.",
      "Inject module files at runtime for plugin scenarios.",
      "Execute safely through host-boundary handlers.",
    ],
    lang: "typescript",
    code: `import { compile } from "@voyd/sdk/browser";

const source = \
\`use src::plugin::all

pub fn main() -> i32
  plugin_score()\`;

const files = {
  "plugin.voyd": "pub fn plugin_score() -> i32\\n  99\\n",
};

const result = await compile(source, { files });
if (!result.success) throw new Error("Plugin compile failed");

const bytes = result.module.emitBinary();
console.log("Plugin wasm size", bytes.length);`,
  },
];

const TOOLING_FEATURES: Feature[] = [
  {
    id: "reporter",
    title: "Built-in test reporter",
    description:
      "Test discovery, execution, events, and summaries are first-class in the SDK and CLI.",
    points: [
      "Emit structured events for CI dashboards.",
      "Support skip/only and per-test diagnostics.",
      "Run isolated tests or shared-runtime suites.",
    ],
    lang: "typescript",
    code: `import { createSdk } from "@voyd/sdk";

const sdk = createSdk();
const result = await sdk.compile({
  entryPath: "./src/pkg.voyd",
  includeTests: true,
});

if (result.success && result.tests) {
  const summary = await result.tests.run({
    reporter: {
      onEvent(event) {
        if (event.type === "test:result") {
          console.log(event.result.displayName, event.result.status);
        }
      },
    },
  });

  console.log(summary);
}`,
  },
  {
    id: "docs",
    title: "Built-in doc generator",
    description:
      "Generate HTML or JSON API docs directly from source declarations. This powers std docs generation.",
    points: [
      "Derive docs from real declarations and signatures.",
      "Produce HTML for websites or JSON for custom pipelines.",
      "Reuse in CI to keep docs and code in lockstep.",
    ],
    lang: "typescript",
    code: `import { writeFile } from "node:fs/promises";
import { generateDocumentation } from "@voyd/sdk/doc-generation";

const { content } = await generateDocumentation({
  entryPath: "./packages/std/src/pkg.voyd",
  format: "html",
});

await writeFile("./build/std-docs.html", content);`,
  },
];

const MORE_CAPABILITIES = [
  {
    title: "Wasm-first pipeline",
    detail:
      "Parser, semantics, and codegen are designed around a stable codegen-view boundary.",
  },
  {
    title: "Language server support",
    detail:
      "LSP server and VSCode extension share compiler semantics for consistent tooling.",
  },
  {
    title: "Public SDK targets",
    detail:
      "Use one SDK across Node, browser, and Deno with aligned compile/run/test flows.",
  },
  {
    title: "Host boundary protocol",
    detail:
      "Typed effect/continuation boundaries make embedding safe and deterministic.",
  },
  {
    title: "Companion test modules",
    detail:
      "Include tests in selected module scopes without polluting production bundles.",
  },
  {
    title: "Maintainable architecture",
    detail:
      "Monorepo packages separate compiler internals, runtime, SDK, and product surfaces.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-16 pt-6">
      <Hero />
      <section className="space-y-5" aria-label="Core features">
        {CORE_FEATURES.map((feature, index) => (
          <FeatureSection
            key={feature.id}
            feature={feature}
            reverse={index % 2 === 1}
          />
        ))}
      </section>
      <section className="space-y-5 pt-6">
        <header className="flex max-w-3xl flex-col gap-2">
          <Eyebrow>Built-in tooling</Eyebrow>
          <h2 className="m-0 text-3xl leading-tight font-bold sm:text-4xl">
            Production-ready workflow support
          </h2>
          <MutedParagraph className="text-base leading-7">
            Voyd includes native support for tests, docs, and runtime
            integration, so teams can standardize on one language and one
            toolchain.
          </MutedParagraph>
        </header>

        <div className="grid gap-4 lg:grid-cols-2">
          {TOOLING_FEATURES.map((feature) => (
            <ToolingCard key={feature.id} feature={feature} />
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MORE_CAPABILITIES.map((capability) => (
            <SurfaceArticle key={capability.title} className="p-4">
              <h3 className="m-0 text-base font-bold">{capability.title}</h3>
              <MutedParagraph className="mt-2 text-sm leading-6">
                {capability.detail}
              </MutedParagraph>
            </SurfaceArticle>
          ))}
        </div>
      </section>
    </main>
  );
}

const Hero = () => {
  return (
    <SurfaceSection
      className="relative isolate mb-12 overflow-hidden px-4 py-10 sm:px-6 sm:py-14 lg:px-8"
      style={{
        background: "color-mix(in srgb, var(--site-surface) 90%, transparent)",
      }}
    >
      <div
        className="pointer-events-none absolute left-1/2 top-[46%] z-0 aspect-[2.35/1] w-[44rem] max-w-[98vw] -translate-x-1/2 -translate-y-1/2 opacity-[0.52] sm:max-w-[98vw]"
        aria-hidden="true"
      >
        <div
          className="absolute inset-0 rounded-[999px] blur-[15px]"
          style={{
            background:
              "radial-gradient(ellipse at center, var(--site-hero-halo) 0%, color-mix(in srgb, var(--site-hero-halo) 50%, transparent) 38%, transparent 72%)",
          }}
        />
        <div
          className="animate-[lens-shift_16s_ease-in-out_infinite_alternate] absolute inset-0 rounded-[999px] blur-[5px]"
          style={{
            transform: "rotate(-11deg) scaleX(1.04)",
            background:
              "radial-gradient(ellipse at center, transparent 37%, var(--site-hero-warp) 47%, transparent 58%)",
          }}
        />
        <div
          className="absolute inset-0 rounded-[999px] blur-[1.2px]"
          style={{
            transform: "rotate(-12deg)",
            background:
              "radial-gradient(ellipse at center, transparent 42%, var(--site-hero-ring) 49%, transparent 56%)",
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            inset: "41% 46%",
            background:
              "radial-gradient(circle, var(--site-hero-core), transparent 75%)",
            boxShadow:
              "0 0 18px color-mix(in srgb, var(--site-hero-core) 65%, transparent)",
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center gap-5 text-center">
        <h1 className="m-0 text-[clamp(3rem,9vw,5.4rem)] leading-[0.92] font-bold tracking-[0.02em] lowercase">
          voyd
        </h1>
        <MutedParagraph className="w-full max-w-[40rem] text-[clamp(1.05rem,2.15vw,1.45rem)] leading-relaxed">
          A high-performance language for full stack web development with a
          strong type system, typed effects, and first-class runtime embedding.
        </MutedParagraph>
        <Links />
      </div>
    </SurfaceSection>
  );
};

const FeatureSection = ({
  feature,
  reverse,
}: {
  feature: Feature;
  reverse: boolean;
}) => {
  const contentOrderClass = reverse ? "lg:order-2" : "lg:order-1";
  const codeOrderClass = reverse ? "lg:order-1" : "lg:order-2";

  return (
    <SurfaceArticle className="p-3 flex flex-col md:flex-row gap-4">
      <div
        className={`m-1 flex flex-col gap-3 ${contentOrderClass} md:w-1/2 p-1`}
      >
        <h2 className="m-0 text-3xl leading-tight font-bold sm:text-[2rem]">
          {feature.title}
        </h2>
        <MutedParagraph className="text-base leading-7">
          {feature.description}
        </MutedParagraph>
        <FeaturePoints points={feature.points} />
      </div>
      <CodePanel
        code={feature.code}
        lang={feature.lang ?? "voyd"}
        className={`${codeOrderClass} md:w-1/2`}
      />
    </SurfaceArticle>
  );
};

const ToolingCard = ({ feature }: { feature: Feature }) => {
  return (
    <SurfaceArticle className="flex flex-col gap-3 p-4">
      <h3 className="m-0 text-2xl font-bold">{feature.title}</h3>
      <MutedParagraph className="text-base leading-7">
        {feature.description}
      </MutedParagraph>
      <FeaturePoints points={feature.points} />
      <CodePanel code={feature.code} lang={feature.lang ?? "voyd"} />
    </SurfaceArticle>
  );
};

const SurfaceSection = ({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) => {
  return (
    <section
      className={`rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] ${className}`}
      style={style}
    >
      {children}
    </section>
  );
};

const SurfaceArticle = ({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) => {
  return (
    <article
      className={`rounded-2xl border border-[var(--site-border)] bg-[var(--site-surface)] ${className}`}
    >
      {children}
    </article>
  );
};

const Eyebrow = ({ children }: { children: ReactNode }) => {
  return (
    <p className="m-0 text-xs font-extrabold tracking-[0.16em] text-[var(--site-text-muted)] uppercase">
      {children}
    </p>
  );
};

const MutedParagraph = ({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) => {
  return (
    <p className={`m-0 text-[var(--site-text-muted)] ${className}`}>
      {children}
    </p>
  );
};

const FeaturePoints = ({ points }: { points: string[] }) => {
  return (
    <ul className="grid gap-2 pl-5 leading-6 text-[var(--site-text-muted)]">
      {points.map((point) => (
        <li key={point}>{point}</li>
      ))}
    </ul>
  );
};

const CodePanel = ({
  code,
  lang,
  className = "",
}: {
  code: string;
  lang: string;
  className?: string;
}) => {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-[var(--site-border)] bg-[#0d1117] ${className}`}
    >
      <CodeBlock code={code} lang={lang} />
    </div>
  );
};

const Links = () => {
  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-3">
      <Link
        to="/docs"
        className="rounded-md border border-transparent bg-[var(--site-button-solid-bg)] px-4 py-2 font-bold text-[var(--site-button-solid-fg)] transition hover:opacity-90"
      >
        Read the Docs
      </Link>
      <a
        href="https://github.com/voyd-lang/voyd"
        className="rounded-md border border-[var(--site-button-ghost-border)] bg-[var(--site-surface)] px-4 py-2 font-bold transition hover:bg-[var(--site-surface-soft)]"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
    </div>
  );
};
