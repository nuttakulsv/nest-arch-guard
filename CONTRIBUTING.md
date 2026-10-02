# Contributing

Thanks for taking the time. Issues and pull requests are welcome in English or Thai.

## Reporting a bug

The fastest way to get a fix is a small project that shows the problem. Strip it down to the modules involved, then either attach it to the issue or add it under `test/fixtures/` in a pull request. Include the command you ran, what you expected and what you got.

## Development

```bash
npm install
npm test           # vitest, runs the analyzer on the fixtures
npm run lint
npm run typecheck
npm run build
npm run images     # re-render docs/images from the shop fixture
```

Most changes come with a fixture. `test/fixtures/shop` is the shared example project; add to it when a new case fits, or create a new folder when it doesn't. Tests should check the exact violations, not only their count.

Please keep pull requests focused on one change and update both READMEs when behavior visible to users changes.
