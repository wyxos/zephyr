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

Configuration is saved to `release.json` for future deployments.

## Features

- Automated Git operations (branch switching, commits, pushes)
- SSH-based deployment to remote servers
- Laravel project detection with smart task execution
- Intelligent dependency management (Composer, npm)
- Database migrations when detected
- Frontend asset compilation
- Cache clearing and queue worker management
- SSH key validation and management

## Smart Task Execution

Zephyr analyzes changed files and runs appropriate tasks:

- **Always**: `git pull origin <branch>`
- **Composer files changed**: `composer update`
- **Migration files added**: `php artisan migrate`
- **package.json changed**: `npm install`
- **Frontend files changed**: `npm run build`
- **PHP files changed**: Clear Laravel caches, restart queues

## Configuration

Deployment targets are stored in `release.json`:

```json
[
  {
    "serverName": "production",
    "serverIp": "192.168.1.100",
    "projectPath": "~/webapps/myapp",
    "branch": "main",
    "sshUser": "forge",
    "sshKey": "~/.ssh/id_rsa"
  }
]
```

## Requirements

- Node.js 16+
- Git
- SSH access to target servers