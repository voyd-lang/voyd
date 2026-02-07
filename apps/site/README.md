# Voyd Programming Language Website

This repository contains the source for [voyd-lang.github.io](https://voyd-lang.github.io), the official website for the **Voyd** programming language.

The site is built with [React Router v7](https://reactrouter.com/) using server-side rendering and Tailwind CSS. Pages are pre-rendered and deployed to GitHub Pages via GitHub Actions.

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

The static files are generated in `build/client`.

## Deploy

Pushes to the `main` branch automatically build and publish the site to GitHub Pages using the workflow in `.github/workflows/deploy.yml`.
