# star.voyd

## Goals and Terminology

- **star.voyd**: a React-like framework for the Voyd language.
- **Functional components**: pure functions mapping props to DOM structures.
- **No state or effects**: initial MVP omits `useState`, `useEffect`, or other side-effect primitives. Components are rendered solely from their inputs.

## DOM Binding Requirements

- **Browser binding**: efficient interface between WebAssembly and the browser's DOM for client-side rendering.
- **jsdom binding**: parallel implementation using `jsdom` to enable server-side rendering during compilation or tests.
- Both bindings expose a common interface so components compile once and run in both environments.

## Virtual DOM Expectations

- Maintain a minimal virtual representation of the DOM.
- On updates, diff the new virtual tree against the previous one and patch only the necessary nodes.
- The diff/patch workflow should aim for performance comparable to JavaScript React.

## MVP Scope

- Render functional components to browser DOM or `jsdom`.
- Support prop changes and re-rendering with efficient diffing.
- Exclude state management, side effects, and hooks.

## Open Questions / TODOs

- How to handle event listeners and cleanup without hooks.
- Strategy for hydration when rendering initially on the server.
- Defining the exact shape and lifetime of the virtual DOM nodes.
- Error boundaries or handling rendering failures.
