import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { findPhpBinary, getPhpVersionRequirement } from '#src/infrastructure/php/version.mjs'

const tempDirs = []

async function createTempProject() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zephyr-php-version-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })))
})

describe('infrastructure/php/version', () => {
  it('reads the root composer PHP requirement when no lock file is present', async () => {
    const rootDir = await createTempProject()

    await writeFile(path.join(rootDir, 'composer.json'), JSON.stringify({
      require: {
        php: '^8.3'
      }
    }))

    await expect(getPhpVersionRequirement(rootDir)).resolves.toBe('8.3.0')
  })

  it('prefers the higher locked runtime PHP requirement over composer.json', async () => {
    const rootDir = await createTempProject()

    await writeFile(path.join(rootDir, 'composer.json'), JSON.stringify({
      require: {
        php: '^8.3'
      }
    }))

    await writeFile(path.join(rootDir, 'composer.lock'), JSON.stringify({
      packages: [
        {
          name: 'symfony/string',
          require: {
            php: '>=8.4'
          }
        }
      ],
      'packages-dev': [
        {
          name: 'brianium/paratest',
          require: {
            php: '~8.5.0'
          }
        }
      ],
      platform: {
        php: '^8.3'
      }
    }))

    await expect(getPhpVersionRequirement(rootDir)).resolves.toBe('8.4.0')
  })

  it('ignores dev-only lock requirements when determining deploy PHP', async () => {
    const rootDir = await createTempProject()

    await writeFile(path.join(rootDir, 'composer.json'), JSON.stringify({
      require: {
        php: '^8.3'
      }
    }))

    await writeFile(path.join(rootDir, 'composer.lock'), JSON.stringify({
      packages: [
        {
          name: 'laravel/framework',
          require: {
            php: '^8.2'
          }
        }
      ],
      'packages-dev': [
        {
          name: 'brianium/paratest',
          require: {
            php: '~8.5.0'
          }
        }
      ],
      platform: {
        php: '^8.3'
      }
    }))

    await expect(getPhpVersionRequirement(rootDir)).resolves.toBe('8.3.0')
  })

  it('selects the matching RunCloud PHP binary when it is available', async () => {
    const ssh = {
      execCommand: async (command) => {
        if (command === 'ls -1 /RunCloud/Packages 2>/dev/null || true') {
          return { stdout: 'php83rc\nphp84rc\n', code: 0 }
        }

        if (command.includes('/RunCloud/Packages/php84rc/bin/php -r "echo PHP_VERSION;"')) {
          return { stdout: '8.4.6', code: 0 }
        }

        if (command.includes('/RunCloud/Packages/php83rc/bin/php -r "echo PHP_VERSION;"')) {
          return { stdout: '8.3.29', code: 0 }
        }

        return { stdout: '', code: 1 }
      }
    }

    await expect(findPhpBinary(ssh, '/home/runcloud/webapps/demo', '8.4.0'))
      .resolves.toBe('/RunCloud/Packages/php84rc/bin/php')
  })

  it('fails fast when no remote PHP binary satisfies the locked requirement', async () => {
    const ssh = {
      execCommand: async (command) => {
        if (command === 'ls -1 /RunCloud/Packages 2>/dev/null || true') {
          return { stdout: 'php83rc\n', code: 0 }
        }

        if (command.includes('/RunCloud/Packages/php83rc/bin/php -r "echo PHP_VERSION;"')) {
          return { stdout: '8.3.29', code: 0 }
        }

        if (command.includes(`bash -lc 'command -v php84' 2>/dev/null || true`)) {
          return { stdout: '', code: 0 }
        }

        if (command.includes(`bash -lc 'command -v php8.4' 2>/dev/null || true`)) {
          return { stdout: '', code: 0 }
        }

        if (command === 'command -v php8.4' || command === 'command -v php84') {
          return { stdout: '', code: 1 }
        }

        if (command === 'php -r "echo PHP_VERSION;"') {
          return { stdout: '8.3.29', code: 0 }
        }

        return { stdout: '', code: 1 }
      }
    }

    await expect(findPhpBinary(ssh, '/home/runcloud/webapps/demo', '8.4.0'))
      .rejects.toThrow('No PHP binary satisfying 8.4.0 was found on the remote server. The default php command reports 8.3.29.')
  })
})
