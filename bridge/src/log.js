/**
 * Logging. ALWAYS to stderr — stdout is the MCP stdio JSON-RPC channel and
 * must never carry human text. The pairing token is never passed here
 * (security invariant, spec §6: never log the token); the banner that prints
 * the code does so directly and deliberately, not through this logger.
 */

const PREFIX = '[clenby-bridge]';

/** @param {...unknown} args */
export function log(...args) {
  process.stderr.write(`${PREFIX} ${args.map(String).join(' ')}\n`);
}

/** @param {...unknown} args */
export function warn(...args) {
  process.stderr.write(`${PREFIX} WARN ${args.map(String).join(' ')}\n`);
}
