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

Navigate to your project directory and run:

```bash
zephyr
```

See all flags:

```bash
zephyr --help
```

Common flags:

```bash
# Run a release workflow
zephyr --type node

# Skip the best-effort update check for this run
zephyr --skip-version-check
```

Follow the interactive prompts to configure your deployment target:
- Server name and IP address
- Project path on the remote server
- Git branch to deploy
- SSH user and private key

Configuration is saved automatically for future deployments.

## Update Checks

When run via `npx`, Zephyr can prompt to re-run itself using the latest published version.

- **Skip update check**:
  - Set `ZEPHYR_SKIP_VERSION_CHECK=1`, or
  - Use `zephyr --skip-version-check`

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
- **Composer files changed** (`composer.json` / `composer.lock`): `composer update --no-dev --no-interaction --prefer-dist`
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