import { lstatSync, realpathSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'

/**
 * Reject an existing path when any component is a symbolic link or junction.
 *
 * Comparing `realpath()` text with `resolve()` is not valid on Windows: the
 * same directory can be spelled with an 8.3 short component such as
 * `ADMINI~1`, while `realpath()` returns the long spelling. Inspecting each
 * component preserves the redirect guard without rejecting that legitimate
 * alias.
 */
export function assertPathHasNoRedirectComponents(target: string, errorCode: string): void {
  const absolute = resolve(target)
  // Require a completely resolvable existing path before component checks.
  realpathSync.native(absolute)
  const root = parse(absolute).root
  let cursor = root
  const tail = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean)
  for (const part of tail) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(errorCode)
  }
}

