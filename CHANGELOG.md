# Changelog

## 0.1.0 - 2026-10-02

First release.

- Reads `@Module()` metadata with the TypeScript compiler: imports, providers, controllers and exports, including spreads, `const` arrays, `forRoot()`/`register()` calls, `forwardRef`, barrel re-exports and static methods that return dynamic modules.
- Rules: `onlyThroughPublicApi` (file imports and constructor injection), `noCycles` (modules and files), `dependencies`, `layers`, `noDeepImports`, `forbidden`.
- Boundaries by path glob or Nest module name; the most specific path wins.
- Baseline file for existing codebases and `arch-guard-ignore-next-line` comments.
- Output as a terminal report, GitHub workflow annotations or JSON.
- `diagram` writes a Mermaid flowchart into `docs/architecture.md`, optional SVG, and `--check` for CI.
- `init` writes `arch.config.ts` from the current structure.
