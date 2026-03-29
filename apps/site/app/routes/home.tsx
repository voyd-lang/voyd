import type { Route } from "./+types/home";

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import CodeBlock from "~/components/CodeBlock";
import logo from "../../assets/logo.svg";

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

type Capability = {
  title: string;
  detail: string;
  points?: string[];
  linkHref?: string;
  linkLabel?: string;
};

type HeroStar = {
  originX: number;
  originY: number;
  angle: number;
  start: number;
  end: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
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

fn Home() -> Html
  // Built in html support
  <div>
    <h1>Hello, World></h1>
    <p>Welcome to voyd.</p>
  </div>`,
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
      "Effects make required capabilities explicit, so domain logic can stay portable while hosts provide concrete behavior.",
    points: [
      "Effect rows make required capabilities visible in signatures.",
      "Handle capabilities at the boundary with `try` clauses.",
      "Keep domain logic decoupled from the host.",
    ],
    code: `eff Confirm
  ask(tail, message: String) -> bool

fn delete_project(name: String): Confirm -> String
  if Confirm::ask("Delete \${name}?"):
    "Deleted \${name}"
  else:
    "Kept \${name}"

fn main(): () -> String
  try
    delete_project("staging-dashboard")
  ask(tail, message):
    tail(true)`,
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
    code: `
// This is a JS file.
import { compile } from "@voyd-lang/sdk/browser";

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
    lang: "bash",
    code: `❯ voyd test

PASS src::set::set insert contains remove clear
PASS src::set::set values returns iterable keys
PASS src::string_bytes_iterator.test::string to_utf8 iterates utf8 bytes
PASS src::time::system_time unix_millis is pure
PASS src::time::sleep decodes host errors
PASS src::time::on_timeout invokes callback on success
PASS src::time::on_timeout decodes host errors and skips callback
PASS src::time::on_interval repeats callbacks and surfaces host errors
PASS src::time::on_interval clears timer when sleep fails
PASS src::traits::contracts.test::trait contracts work for baseline std traits

passed 210, failed 0, skipped 0 (210 total)
`,
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
    lang: "bash",
    code: `❯ voyd doc --out project_docs.html`,
  },
];

const MORE_CAPABILITIES: Capability[] = [
  {
    title: "Wasm-first pipeline",
    detail:
      "Parser, semantics, and codegen are designed around a stable codegen-view boundary.",
  },
  {
    title: "VSCode extension",
    detail:
      "Edit Voyd with focused IDE tooling for day-to-day language workflows. Supports refactoring, auto imports, error highlighting and more.",
    linkHref:
      "https://marketplace.visualstudio.com/items?itemName=voyd-lang.voyd-vscode",
    linkLabel: "Open extension",
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

const HERO_STARS: HeroStar[] = Array.from({ length: 1280 }, (_, index) => {
  const layer = index % 5;
  const angle = ((index * 137.507764 + layer * 29) % 360) - 180;
  const bandStart = [182, 220, 270, 330, 395][layer];
  const bandTravel = [220, 265, 315, 370, 450][layer];
  const start = bandStart + ((index * 31) % 78);
  const end = start + bandTravel + ((index * 17) % 140);
  const delay = ((index * 7) % 180) * 0.22;
  const duration = 28 + layer * 4 + ((index * 13) % 30) * 0.38;
  const isLarge = index % 41 === 0;
  const isMedium = !isLarge && index % 9 === 0;
  const size = isLarge
    ? 2.5 + ((index * 11) % 3) * 0.38
    : isMedium
      ? 1.45 + ((index * 19) % 3) * 0.24
      : 0.68 + ((index * 17) % 4) * 0.16;
  const opacity = isLarge
    ? 0.94
    : isMedium
      ? 0.76
      : 0.38 + (((index * 23) % 28) / 100);
  const originX = 50 + Math.cos(index * 0.73) * (2.4 + (layer % 2) * 1.2);
  const originY = 47 + Math.sin(index * 0.51) * (1.9 + ((layer + 1) % 2) * 0.9);

  return {
    originX,
    originY,
    angle,
    start,
    end,
    size,
    delay,
    duration,
    opacity,
  };
});

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 overflow-x-clip px-4 pb-16 pt-6">
      <Hero />
      <SurfaceSection className="space-y-5" aria-label="Core features">
        {CORE_FEATURES.map((feature, index) => (
          <FeatureSection
            key={feature.id}
            feature={feature}
            reverse={index % 2 === 1}
          />
        ))}
      </SurfaceSection>
      <SurfaceSection className="space-y-8">
        <header className="flex max-w-3xl ml-3 flex-col gap-2">
          <h2 className="mt-3 text-3xl leading-tight font-bold sm:text-4xl">
            Batteries Included
          </h2>
          <MutedParagraph className="text-base leading-7">
            Voyd includes native support for tests, docs, and runtime
            integration, so full stack projects can standardize on one language
            and one toolchain.
          </MutedParagraph>
        </header>

        <div className="grid gap-4 lg:grid-cols-2 lg:auto-rows-fr">
          {TOOLING_FEATURES.map((feature) => (
            <ToolingCard key={feature.id} feature={feature} />
          ))}
        </div>

        <SurfaceArticle className="grid gap-3 sm:grid-cols-2 sm:auto-rows-fr lg:grid-cols-3 p-3">
          {MORE_CAPABILITIES.map((capability) => (
            <div
              key={capability.title}
              className="flex h-full flex-col p-4"
            >
              <h3 className="m-0 text-base font-bold">{capability.title}</h3>
              <MutedParagraph className="mt-2 text-sm leading-6">
                {capability.detail}
              </MutedParagraph>
              {capability.points && capability.points.length > 0 ? (
                <ul className="mt-2 grid gap-1.5 pl-5 text-sm leading-6 text-[var(--site-text-muted)]">
                  {capability.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              ) : null}
              {capability.linkHref ? (
                <a
                  href={capability.linkHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex w-fit rounded-md border border-[var(--site-button-ghost-border)] bg-[var(--site-surface)] px-3 py-1.5 text-sm font-bold transition hover:bg-[var(--site-surface-soft)]"
                >
                  {capability.linkLabel ?? "Learn more"}
                </a>
              ) : null}
            </div>
          ))}
        </SurfaceArticle>
      </SurfaceSection>
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
      <HeroStars />
      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center gap-5 text-center">
        <div className="flex flex-row gap-2 items-center justify-center">
          <img src={logo} alt="Voyd logo" className="aspect-square w-20" />
          <h1 className="m-0 text-[clamp(3rem,9vw,5.4rem)] leading-[0.92] font-bold tracking-[0.02em] lowercase">
            voyd
          </h1>
        </div>
        <MutedParagraph className="w-full max-w-[40rem] text-[clamp(1.05rem,2.15vw,1.45rem)] leading-relaxed">
          A programming language for full stack web development with a strong
          type system, typed effects, and first-class runtime embedding.
        </MutedParagraph>
        <Links />
      </div>
    </SurfaceSection>
  );
};

const HeroStars = () => {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {HERO_STARS.map((star, index) => (
        <span
          key={`${star.angle}-${index}`}
          className="hero-star"
          style={
            {
              "--hero-star-origin-x": `${star.originX}%`,
              "--hero-star-origin-y": `${star.originY}%`,
              "--hero-star-angle": `${star.angle}deg`,
              "--hero-star-start": `${star.start}px`,
              "--hero-star-end": `${star.end}px`,
              "--hero-star-size": `${star.size}px`,
              "--hero-star-delay": `${star.delay}s`,
              "--hero-star-duration": `${star.duration}s`,
              "--hero-star-opacity": `${star.opacity}`,
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
  const contentOrderClass = reverse ? "lg:order-2" : "lg:order-1";
  const codeOrderClass = reverse ? "lg:order-1" : "lg:order-2";

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 md:flex-row">
      <div
        className={`m-1 flex min-w-0 flex-col gap-3 p-1 ${contentOrderClass} md:w-1/2`}
      >
        <h2 className="m-0 mt text-3xl leading-tight font-bold sm:text-[2rem]">
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
        className={`min-w-0 ${codeOrderClass} md:w-1/2`}
      />
    </div>
  );
};

const ToolingCard = ({ feature }: { feature: Feature }) => {
  return (
    <div className="flex h-full flex-col gap-10 p-3">
      <div className="gap-3">
        <h3 className="m-0 mb-1.5 text-2xl font-bold">{feature.title}</h3>
        <MutedParagraph className="text-base leading-6">
          {feature.description}
        </MutedParagraph>
        <FeaturePoints points={feature.points} />
      </div>
      <CodePanel
        code={feature.code}
        lang={feature.lang ?? "voyd"}
      />
    </div>
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
      className={`min-w-0 rounded-xl shadow-xl bg-[var(--site-surface)] p-3 ${className}`}
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
      className={`rounded-xl shadow-xl bg-[var(--site-surface)] ${className}`}
    >
      {children}
    </article>
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
    <ul className="mt-1.5 grid gap-2 pl-5 leading-5 text-[var(--site-text-muted)]">
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
      className={`max-w-full min-w-0 overflow-hidden rounded-xl border border-[var(--site-border)] bg-[#0d1117] ${className}`}
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
        Docs
      </Link>
      <a
        href="https://github.com/voyd-lang/voyd"
        className="rounded-md border border-[var(--site-button-ghost-border)] bg-[var(--site-surface)] px-4 py-2 font-bold transition hover:bg-[var(--site-surface-soft)]"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
      <a
        href="https://marketplace.visualstudio.com/items?itemName=voyd-lang.voyd-vscode"
        className="rounded-md border border-[var(--site-button-ghost-border)] bg-[var(--site-surface)] px-4 py-2 font-bold transition hover:bg-[var(--site-surface-soft)]"
        target="_blank"
        rel="noopener noreferrer"
      >
        VSCode
      </a>
    </div>
  );
};
