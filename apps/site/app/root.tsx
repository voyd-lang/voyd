import { useEffect, useState } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useHref,
  useLocation,
} from "react-router";
import logo from "../assets/logo-inverted.svg";

import type { Route } from "./+types/root";
import "./app.css";

const THEME_STORAGE_KEY = "voyd-theme-preference";

type ThemePreference = "light" | "dark" | "system";

const THEME_INIT_SCRIPT = `(() => {
  try {
    const key = "${THEME_STORAGE_KEY}";
    const stored = window.localStorage.getItem(key);
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
      return;
    }
    document.documentElement.removeAttribute("data-theme");
  } catch {
    document.documentElement.removeAttribute("data-theme");
  }
})();`;

const NAV_LINK_CLASS =
  "text-sm font-semibold opacity-[0.85] underline-offset-4 transition hover:opacity-100 hover:underline";
const MOBILE_NAV_LINK_CLASS =
  "block rounded-md px-3 py-2 text-sm font-semibold transition hover:bg-[var(--site-surface-soft)]";

const isThemePreference = (value: string | null): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

const applyThemePreference = (preference: ThemePreference) => {
  if (typeof document === "undefined") {
    return;
  }

  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }

  document.documentElement.setAttribute("data-theme", preference);
};

const ThemeToggle = ({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) => {
  const options: ThemePreference[] = ["light", "dark", "system"];

  return (
    <div
      className="inline-flex gap-1 rounded-full border border-[var(--site-border)] bg-[var(--site-surface-soft)] p-[3px]"
      role="group"
      aria-label="Theme mode"
    >
      {options.map((option) => {
        const isActive = value === option;
        return (
          <button
            key={option}
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${
              isActive
                ? "bg-[var(--site-surface)] opacity-100 shadow-sm"
                : "opacity-70 hover:opacity-100"
            }`}
            onClick={() => onChange(option)}
            aria-pressed={isActive}
          >
            {option[0]?.toUpperCase()}
            {option.slice(1)}
          </button>
        );
      })}
    </div>
  );
};

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,200..1000;1,200..1000&display=swap",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const stdDocsPath = useHref("/std/");
  const location = useLocation();
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    "system",
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const resolvedPreference = isThemePreference(stored) ? stored : "system";
    setThemePreference(resolvedPreference);
    applyThemePreference(resolvedPreference);
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname, location.search]);

  const onThemeChange = (next: ThemePreference) => {
    setThemePreference(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyThemePreference(next);
  };

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen overflow-x-hidden bg-[var(--site-page-bg)] font-sans text-[var(--foreground)] antialiased">
        <header
          className="sticky top-0 z-[60] border-b border-[var(--site-border)] backdrop-blur"
          style={{
            background: "color-mix(in srgb, var(--site-surface) 86%, transparent)",
          }}
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:py-4">
            <div className="flex items-center justify-between gap-3">
              <Link
                to="/"
                className="inline-flex items-center gap-2 text-[1.05rem] font-extrabold tracking-[0.02em] lowercase"
              >
                <img src={logo} alt="Voyd logo" className="h-7 w-7" />
                <span>voyd</span>
              </Link>

              <button
                type="button"
                className="inline-flex items-center rounded-md border border-[var(--site-border)] bg-[var(--site-surface)] px-3 py-1.5 text-sm font-semibold sm:hidden"
                onClick={() => setIsMobileMenuOpen((isOpen) => !isOpen)}
                aria-expanded={isMobileMenuOpen}
                aria-controls="mobile-nav-menu"
              >
                Menu
              </button>

              <div className="hidden items-center gap-4 sm:flex">
                <nav className="flex items-center gap-4">
                  <Link to="/docs" className={NAV_LINK_CLASS}>
                    Docs
                  </Link>
                  <Link to="/playground" className={NAV_LINK_CLASS}>
                    Playground
                  </Link>
                  <a href={stdDocsPath} className={NAV_LINK_CLASS}>
                    Std Docs
                  </a>
                  <a
                    href="https://github.com/voyd-lang/voyd"
                    className={NAV_LINK_CLASS}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                </nav>
                <ThemeToggle value={themePreference} onChange={onThemeChange} />
              </div>
            </div>

            <div
              id="mobile-nav-menu"
              className={`${isMobileMenuOpen ? "mt-3 grid gap-2" : "hidden"} sm:hidden`}
            >
              <nav className="grid gap-1 rounded-xl border border-[var(--site-border)] bg-[var(--site-surface)] p-2">
                <Link to="/docs" className={MOBILE_NAV_LINK_CLASS}>
                  Docs
                </Link>
                <Link to="/playground" className={MOBILE_NAV_LINK_CLASS}>
                  Playground
                </Link>
                <a href={stdDocsPath} className={MOBILE_NAV_LINK_CLASS}>
                  Std Docs
                </a>
                <a
                  href="https://github.com/voyd-lang/voyd"
                  className={MOBILE_NAV_LINK_CLASS}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
              </nav>

              <div className="rounded-xl border border-[var(--site-border)] bg-[var(--site-surface)] p-2">
                <ThemeToggle value={themePreference} onChange={onThemeChange} />
              </div>
            </div>
          </div>
        </header>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
