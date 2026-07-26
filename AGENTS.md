# Yoplai

Start by reading `./docs/llms.md`.

Ask early and often if anything is ambiguous.

After a code update, make sure to keep documentation up to date, mainly:
- @`./docs/llms.md` is the documentation for LLMs.
- @`./README.md` is for humans.

## Testing

Tests: use scoped scripts for package-level runs: `pnpm test:web`, `pnpm test:gateway`, `pnpm test:shared`, `pnpm test:cli`. For single tests, use an exact file path: `pnpm exec vitest run <path-to-test-file>`. Avoid `pnpm test -- <path>` here; positional Vitest filters are unreliable in this repo. Run tests serially (one command at a time); parallel runs can cause transient `ENOENT` in subagent runner tests. Run `pnpm install` if `node_modules` is missing.

When implementing user-facing changes, and `./docs/validation_e2e.md` exists, follow the instructions in that file to perform an e2e test of your changes.

## Git Behavior

Commit: while keeping the first line short, make sure to explain **why** the commit was made in the commit body. If it solves an issue or addresses a key need, explain it. Code diff already explains *what* was changed, so the commit should always explain *why* the commit was made, what underlying problem or need it solves.
