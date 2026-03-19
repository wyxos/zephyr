# @wyxos/zephyr

A streamlined deployment tool for web applications with intelligent Laravel project detection.

## Installation

```bash
npm install -g @wyxos/zephyr
```

Or run directly with npx:

```bash
npx @wyxos/zephyr
```

## Usage

Navigate to your app or package directory and run:

```bash
npm run release
```

Or invoke Zephyr directly:

```bash
zephyr
```

See all flags:

```bash
zephyr --help
```

Common workflows:

```bash
# Deploy an app using the saved preset or the interactive prompts
zephyr

# Deploy an app and bump the local npm package version first
zephyr minor

# Deploy a configured app non-interactively
zephyr --non-interactive --preset wyxos-release --maintenance off

# Resume a pending non-interactive deployment
zephyr --non-interactive --preset wyxos-release --resume-pending --maintenance off

# Emit NDJSON events for automation or agent tooling
zephyr --non-interactive --json --preset wyxos-release --maintenance on

# Release a Node/Vue package (defaults to a patch bump)
zephyr --type node

# Release a Node/Vue package with an explicit bump
zephyr --type node minor

# Release a Packagist package
zephyr --type packagist patch
```

When `--type node` or `--type vue` is used without a bump argument, Zephyr defaults to `patch`.

## Interactive and Non-Interactive Modes

Interactive mode remains the default and is the best fit for first-time setup, config repair, and one-off deployments.

Non-interactive mode is strict and is intended for already-configured projects:

- `--non-interactive` fails instead of prompting
- app deployments require `--preset <name>`
- Laravel app deployments require `--maintenance on|off` unless resuming a saved snapshot that already contains the choice
- pending deployment snapshots require either `--resume-pending` or `--discard-pending`
- stale remote locks are never auto-removed in non-interactive mode
- `--json` is only supported together with `--non-interactive`

If Zephyr would normally prompt to:

- create or repair config
- save a preset
- install the `release` script
- confirm local path dependency updates
- resolve a stale remote lock

then non-interactive mode stops immediately with a clear error instead.

For Laravel app deployments, `--maintenance on|off` overrides the maintenance prompt when you want an explicit choice instead of an interactive confirm.

## AI Agents and Automation

Zephyr can be used safely by Codex, CI jobs, or other automation once configuration is already in place.

Recommended pattern for app deployments:

```bash
zephyr --non-interactive --json --preset wyxos-release --maintenance off
```

Recommended pattern for package releases:

```bash
zephyr --type node --non-interactive --json minor
zephyr --type packagist --non-interactive --json patch
```

In `--json` mode Zephyr emits NDJSON events on `stdout` with a stable shape:

- `run_started`
- `log`
- `prompt_required`
- `run_completed`
- `run_failed`

Each event includes:

- `event`
- `timestamp`
- `workflow`
- `message`
- `level` where relevant
- `data`

`run_failed` also includes a stable `code` field for automation checks.

In `--json` mode, Zephyr reserves `stdout` for NDJSON events and routes inherited local command output to `stderr` so agent parsers do not get corrupted.

On a first run inside a project with `package.json`, Zephyr can:
- add `.zephyr/` to `.gitignore`
- add a `release` script that runs `npx @wyxos/zephyr@latest`
- create global server config and per-project deployment config interactively

Follow the interactive prompts to configure your deployment target:
- Server name and IP address
- Project path on the remote server
- Git branch to deploy
- SSH user and private key

Configuration is saved automatically for future deployments.

## Project Scripts

The recommended entrypoint in consumer projects is:

```bash
npm run release
```

- `npm run release` is the recommended app/package entrypoint once the release script has been installed.
- For `--type node` workflows, Zephyr runs your project's `lint` script when present.
- For `--type node` workflows, Zephyr runs `test:run` or `test` when present.
- For non-interactive app deploys, use a saved preset name instead of relying on prompt fallback.

## Features

- Automated Git operations (branch switching, commits, pushes)
- SSH-based deployment to remote servers
- Laravel project detection with smart task execution
- Intelligent dependency management (Composer, npm)
- Database migrations when detected
- Frontend asset compilation
- Cache clearing and queue worker management
- SSH key validation and management
- Deployment locking to prevent concurrent runs
- Task snapshots for resuming failed deployments
- Comprehensive logging of all remote operations

## Smart Task Execution

Zephyr analyzes changed files and runs appropriate tasks:

- **Always**: `git pull origin <branch>`
- **Composer files changed** (`composer.json` / `composer.lock`): `composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader` (requires `composer.lock`)
- **Migrations changed** (`database/migrations/*.php`): `php artisan migrate --force`
- **Node dependency files changed** (`package.json` / `package-lock.json`, including nested): `npm install`
- **Frontend files changed** (`.vue/.js/.ts/.tsx/.css/.scss/.less`): `npm run build`
  - Note: `npm run build` is also scheduled when `npm install` is scheduled.
- **PHP files changed**: clear caches + restart queue workers (Horizon if configured)

## Configuration

### Global Server Configuration

Servers are stored globally at `~/.config/zephyr/servers.json`:

```json
[
  {
    "id": "server_abc123",
    "serverName": "production",
    "serverIp": "192.168.1.100"
  }
]
```

### Project Configuration

Deployment targets are stored per-project at `.zephyr/config.json`:

```json
{
  "presets": [
    {
      "name": "prod-main",
      "appId": "app_def456",
      "branch": "main"
    }
  ],
  "apps": [
    {
      "id": "app_def456",
      "serverId": "server_abc123",
      "serverName": "production",
      "projectPath": "~/webapps/myapp",
      "branch": "main",
      "sshUser": "forge",
      "sshKey": "~/.ssh/id_rsa"
    }
  ]
}
```

### Project Directory Structure

Zephyr creates a `.zephyr/` directory in your project with:
- `config.json` - Project deployment configuration
- `deploy.lock` - Lock file to prevent concurrent deployments
- `pending-tasks.json` - Task snapshot for resuming failed deployments
- `{timestamp}.log` - Log files for each deployment run

The `.zephyr/` directory is automatically added to `.gitignore`.

## Notes

- If Zephyr reports **"No upstream file changes detected"**, it means the remote repository already matches `origin/<branch>` after `git fetch`. In that case, Zephyr will only run `git pull` and skip all conditional maintenance tasks.
- If Zephyr prompts to update local file dependencies (path-based deps outside the repo), it may also prompt to commit those updates before continuing.

## Requirements

- Node.js 16+
- Git
- SSH access to target servers
