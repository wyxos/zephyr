# Copilot Instructions

## Project Snapshot
- Command-line deployment tool (`bin/zephyr.mjs`) that delegates to `src/index.mjs` for all logic.
- Node.js ESM project; keep imports as `import … from` and avoid CommonJS helpers.
- Primary responsibilities: gather deployment config via prompts, ensure local git state, SSH into remote servers, run per-change maintenance tasks.

## Configuration Model
- Global servers live at `~/.config/zephyr/servers.json` (array of `{ serverName, serverIp }`).
- Per-project apps live at `.zephyr/config.json` (apps array with `{ serverName, projectPath, branch, sshUser, sshKey }`).
- `main()` now sequences: ensure `.zephyr/` ignored, load servers, pick/create one, load project config, pick/create app, ensure SSH details, run deployment.
- When adding config logic, reuse helpers: `selectServer`, `promptServerDetails`, `selectApp`, `promptAppDetails`, `ensureProjectConfig`.
- `ensureProjectReleaseScript()` offers to inject a `release` npm script (`npx @wyxos/zephyr@release`) into the host project's `package.json`; prefer updating that helper if the script text changes.

## Deployment Flow Highlights
- Always call `ensureLocalRepositoryState(branch)` before SSH. It:
  - Verifies current branch, fast-forwards with `git pull --ff-only`, warns if ahead, commits + pushes uncommitted changes when needed.
  - Prompts for commit message if dirty and pushes to `origin/<branch>`.
- Remote execution happens via `runRemoteTasks(config)`; keep all SSH commands funneled through `executeRemote(label, command, options)` to inherit logging and error handling.
- Laravel detection toggles extra tasks—Composer, migrations, npm install/build, cache clears, queue restarts—based on changed files from `git diff HEAD..origin/<branch>`.

## Release Workflow
- Automated publishing script at `publish.mjs` (`npm run release`):
  - Checks clean working tree, fetches & fast-forwards branch, runs `npx vitest run`, bumps version via `npm version <type>`, pushes with tags, publishes (adds `--access public` for scoped packages).
  - `npm pkg fix` may adjust `package.json`; commit results before running the release.

## Testing & Tooling
- Test suite: `npm test` (Vitest). Mocks for fs, child_process, inquirer, node-ssh are set up—extend them for new behaviors rather than shelling out.
- Avoid long-running watchers in scripts; tests spawn Vitest in watch mode by default, so kill (`pkill -f vitest`) after scripted runs when necessary.

## Conventions & Style
- Logging helpers (`logProcessing`, `logSuccess`, `logWarning`, `logError`) centralize colored output—use them instead of `console.log` in new deployment logic.
- Use async/await with `runCommand` / `runCommandCapture` for local shell ops; never `exec` directly.
- Keep new prompts routed through `runPrompt`; it supports injection for tests.
- Default to ASCII in files; comments only where logic is non-obvious.
- Update Vitest cases in `tests/index.test.js` when altering prompts, config structure, or deployment steps; tests expect deterministic logging text.
