// globalSetup de Playwright (docs/PLAN.md 2.8, P12): genera los fixtures en tests/.tmp/fixtures/
// antes de los E2E. El generador es idempotente: si ya están, no regenera nada.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export default function globalSetup(): void {
  const root = resolve(__dirname, '..', '..');
  execFileSync(process.execPath, [join(root, 'tests', 'fixtures', 'generate.mjs')], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
}
