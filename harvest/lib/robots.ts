/**
 * A robots.txt parser, in the subset the harvester actually needs.
 *
 * Written by hand rather than pulled from npm because the consuming repo is a
 * dependency-free content library and this is sixty lines. It implements the
 * parts of the de-facto standard that decide whether we may fetch a URL: group
 * selection by user-agent, `Allow`/`Disallow` with `*` and `$`, longest-match
 * precedence, `Sitemap`, and `Crawl-delay`.
 */

export type RobotsRules = {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
  crawlDelay?: number;
};

type Group = { agents: string[]; allow: string[]; disallow: string[]; crawlDelay?: number };

/**
 * Parse `text` and return the rules that apply to `ua`.
 *
 * A group naming our agent wins outright over the wildcard group; if neither
 * appears, nothing is restricted. `Sitemap` is a file-level directive, so it is
 * collected from every group.
 */
export function parseRobots(text: string, ua: string): RobotsRules {
  const agent = ua.toLowerCase();
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  /** Consecutive `User-agent` lines share one group; the first rule closes it. */
  let openToMoreAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const at = line.indexOf(':');
    if (at === -1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!current || !openToMoreAgents) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        openToMoreAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    openToMoreAgents = false;

    // An empty `Disallow` value is the documented way to say "nothing is
    // blocked", so it must not become a rule matching every path.
    if (field === 'disallow' && value) current.disallow.push(value);
    else if (field === 'allow' && value) current.allow.push(value);
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  // Every group naming our agent, not just the first: sites running several
  // plugins routinely emit more than one "User-agent: *" block, and taking
  // only the first silently ignores the rest of their rules.
  const named = groups.filter((g) => g.agents.includes(agent));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes('*'));

  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    sitemaps,
    crawlDelay: chosen.find((g) => g.crawlDelay !== undefined)?.crawlDelay,
  };
}

/** Turn a robots path pattern into an anchored regex. `*` is any run of
 *  characters and a trailing `$` anchors the end; everything else is literal. */
function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

/** The length of the matching pattern, or -1 for no match. */
function matchLength(patterns: string[], path: string): number {
  let best = -1;
  for (const p of patterns) {
    if (toRegExp(p).test(path) && p.length > best) best = p.length;
  }
  return best;
}

/**
 * Longest match wins, and a tie goes to `Allow` — the behaviour both Google and
 * the RFC draft specify, and the reason a site can carve a public subtree out
 * of a blanket `Disallow: /`.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const deny = matchLength(rules.disallow, path);
  if (deny === -1) return true;
  return matchLength(rules.allow, path) >= deny;
}
