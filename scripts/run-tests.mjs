/**
 * Zero-dependency test runner for the TypeScript rules-engine tests.
 *
 * The project has no test framework, so this uses the esbuild binary that
 * already ships with Vite to bundle the test to a temp file and runs it with
 * node. No new dependency, no config change.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = join(root, 'src', 'test', 'studyPlan.test.ts')
const outDir = mkdtempSync(join(tmpdir(), 'focuslearn-test-'))
const outFile = join(outDir, 'studyPlan.test.mjs')

/** Resolve the platform esbuild binary that ships with Vite. */
function esbuildBinary() {
  const shim = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (existsSync(shim)) {
    const exe = `${shim}.exe`
    if (existsSync(exe)) return exe
  }
  const platformDir = join(root, 'node_modules', '@esbuild')
  for (const pkg of readdirSync(platformDir)) {
    const exe = join(platformDir, pkg, 'esbuild.exe')
    if (existsSync(exe)) return exe
  }
  throw new Error('esbuild binary not found — run npm install')
}

try {
  execFileSync(
    esbuildBinary(),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      // Vite injects these at build time; the rules engine only needs them for
      // the API base URL, which the deterministic tests never call.
      '--define:import.meta.env={}',
      `--outfile=${outFile}`,
    ],
    { stdio: 'inherit', cwd: root },
  )
  execFileSync(process.execPath, [outFile], { stdio: 'inherit', cwd: root })
} catch (err) {
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
