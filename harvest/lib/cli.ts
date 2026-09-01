/**
 * The arguments every harvest call to `claude -p` shares.
 *
 * A default invocation inherits the developer's whole environment: every MCP
 * server in the user config is launched for the call, and the tool schemas of
 * all of them are written into the prompt cache before a single word of the
 * recipe is read. Measured on one trivial question:
 *
 *   default  $0.0241  7.6s  10,977 cache-creation tokens
 *   lean     $0.0028  2.8s       0 cache-creation tokens
 *
 * The harvest asks a model to read a page and answer in JSON. It has no use
 * for Gmail, Slack or a database, and paying to describe them tens of
 * thousands of times is most of what the harvest was spending. Sixteen of
 * those startups at once is also what pushed the gate's refuters past their
 * three-minute timeout.
 */
export function leanArgs(): string[] {
  return [
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence',
  ];
}
