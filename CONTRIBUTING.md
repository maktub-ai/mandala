# Contributing to Mandala

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

## Where things go

| You want to… | Go to |
|---|---|
| Report a bug or request a feature | [Issues](https://github.com/maktub-ai/mandala/issues/new/choose) |
| Ask a question or share an idea | [Discussions](https://github.com/maktub-ai/mandala/discussions) |
| Report a security problem | [SECURITY.md](SECURITY.md), never a public issue |
| Submit a theme, language pack or pet | [mandala-plugins](https://github.com/maktub-ai/mandala-plugins) |
| Download the app | [mandala.pub](https://mandala.pub) |

## Before you write code

For anything bigger than a small fix, open an issue or discussion first so we can agree on the approach. It saves you from building something we cannot merge.

## Set up

Requires Node.js 22.23.2 or later.

```bash
git clone https://github.com/maktub-ai/mandala.git
cd mandala
npm ci
npm run dev        # Vite + local API at http://127.0.0.1:4174
```

Use a separate data directory for development so you never touch your everyday workspace:

```bash
MANDALA_HOME="$HOME/.mandala-dev" npm run dev
```

You do not need any CLI logged in to run the tests. They use temporary data and mock protocol endpoints.

## Make the change

- Keep pull requests focused on one change.
- Add or update tests for behaviour changes.
- Match the style of the code around you. UI work follows [DESIGN.md](DESIGN.md).
- Write commit messages, pull requests and code comments in English.
- Never commit credentials, personal data, real task content or real screenshots. Use sample data.

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e   # for UI changes, after `npx playwright install chromium`
```

## Licensing of contributions

Mandala is published under the [Mandala Source-Available License](LICENSE). By submitting a contribution, you confirm that you wrote it or have the right to submit it, and you agree that it is provided under the same license as this repository.

## Code of conduct

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
