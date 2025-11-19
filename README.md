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

Follow the interactive prompts to configure your deployment target:
- Server name and IP address
- Project path on the remote server
- Git branch to deploy
- SSH user and private key

Configuration is saved automatically for future deployments.

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
- **Composer files changed**: `composer update --no-dev --no-interaction --prefer-dist`
- **Migration files added**: `php artisan migrate --force`
- **package.json changed**: `npm install`
- **Frontend files changed**: `npm run build`
- **PHP files changed**: Clear Laravel caches, restart queues

## Configuration

### Global Server Configuration

Servers are stored globally at `~/.config/zephyr/servers.json`:

```json
[
  {
    "serverName": "production",
    "serverIp": "192.168.1.100"
  }
]
```

### Project Configuration

Deployment targets are stored per-project at `.zephyr/config.json`:

```json
{
  "apps": [
    {
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

## Requirements

- Node.js 16+
- Git
- SSH access to target servers