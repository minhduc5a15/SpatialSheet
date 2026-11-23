import type {AppCommand, CommandCategory} from './commands';

export interface RankedCommand {
  command: AppCommand;
  score: number;
  matchKind: 'all' | 'exact' | 'prefix' | 'word-boundary' | 'substring' | 'keyword' | 'fuzzy';
}

export const CATEGORY_ORDER: readonly CommandCategory[] = [
  'Contextual',
  'Navigation',
  'Columns',
  'Sheets',
  'Charts & 3D',
  'Workbook & Data',
  'Inspector & Help',
];

const CATEGORY_RANK = new Map<CommandCategory, number>(
  CATEGORY_ORDER.map((c, idx) => [c, idx])
);

export function normalizeCommandQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/**
 * Computes an ordered fuzzy match score (>= 0) or -1 if query chars cannot match in order.
 * Prefers compact contiguous runs and word-start hits.
 */
function scoreFuzzySubsequence(text: string, query: string): number {
  if (!query || query.length > text.length) return -1;
  let ti = 0;
  let qi = 0;
  let lastMatchIdx = -2;
  let streak = 0;
  let bonus = 0;
  let firstMatchIdx = -1;

  while (ti < text.length && qi < query.length) {
    if (text[ti] === query[qi]) {
      if (firstMatchIdx < 0) firstMatchIdx = ti;
      if (ti === lastMatchIdx + 1) {
        streak += 1;
        bonus += 8 + Math.min(streak * 3, 18);
      } else {
        streak = 0;
      }
      if (ti === 0 || /[^a-z0-9]/i.test(text[ti - 1] ?? '')) {
        bonus += 10;
      }
      lastMatchIdx = ti;
      qi += 1;
    }
    ti += 1;
  }

  if (qi !== query.length) return -1;

  const span = lastMatchIdx - firstMatchIdx + 1;
  // Reject overly sparse accidental matches across long strings
  if (span > query.length * 4 + 6) return -1;

  const compactnessPenalty = Math.max(0, span - query.length) * 2;
  return Math.max(1, 50 + bonus - compactnessPenalty - firstMatchIdx);
}

export function scoreCommandMatch(
  command: AppCommand,
  normalizedQuery: string
): RankedCommand | null {
  const titleLower = command.title.toLowerCase();
  const contextBoost = command.contextWeight ?? 0;
  const enabledBoost = command.isEnabled === false ? -5 : 10;

  if (!normalizedQuery) {
    return {
      command,
      score: 1000 + contextBoost + enabledBoost,
      matchKind: 'all',
    };
  }

  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const subtitleLower = (command.subtitle ?? '').toLowerCase();
  const categoryLower = command.category.toLowerCase();
  const keywordsLower = (command.keywords ?? []).map((k) => k.toLowerCase());
  const titleWords = splitWords(command.title);

  // Exact full-title match
  if (titleLower === normalizedQuery) {
    return {
      command,
      score: 10_000 + contextBoost + enabledBoost,
      matchKind: 'exact',
    };
  }

  // Title prefix match
  if (titleLower.startsWith(normalizedQuery)) {
    return {
      command,
      score: 8_000 + contextBoost + enabledBoost - titleLower.length * 0.1,
      matchKind: 'prefix',
    };
  }

  // Word-boundary prefix in title
  if (titleWords.some((w) => w.startsWith(normalizedQuery))) {
    return {
      command,
      score: 6_500 + contextBoost + enabledBoost - titleLower.length * 0.1,
      matchKind: 'word-boundary',
    };
  }

  // Title substring
  const subIdx = titleLower.indexOf(normalizedQuery);
  if (subIdx >= 0) {
    return {
      command,
      score: 5_000 + contextBoost + enabledBoost - subIdx * 2,
      matchKind: 'substring',
    };
  }

  // Multi-token check: every token must match somewhere in title, keywords, subtitle, or category
  if (tokens.length > 1) {
    const haystack = `${titleLower} ${subtitleLower} ${keywordsLower.join(' ')} ${categoryLower}`;
    const allInTitle = tokens.every((tok) => titleLower.includes(tok));
    if (allInTitle) {
      return {
        command,
        score: 4_500 + contextBoost + enabledBoost,
        matchKind: 'word-boundary',
      };
    }
    const allAnywhere = tokens.every((tok) => haystack.includes(tok));
    if (allAnywhere) {
      return {
        command,
        score: 3_200 + contextBoost + enabledBoost,
        matchKind: 'keyword',
      };
    }
    return null;
  }

  // Single token keyword / subtitle / category match
  if (keywordsLower.some((kw) => kw === normalizedQuery)) {
    return {
      command,
      score: 4_000 + contextBoost + enabledBoost,
      matchKind: 'keyword',
    };
  }
  if (keywordsLower.some((kw) => kw.startsWith(normalizedQuery))) {
    return {
      command,
      score: 3_600 + contextBoost + enabledBoost,
      matchKind: 'keyword',
    };
  }
  if (
    keywordsLower.some((kw) => kw.includes(normalizedQuery)) ||
    subtitleLower.includes(normalizedQuery) ||
    categoryLower.includes(normalizedQuery)
  ) {
    return {
      command,
      score: 2_800 + contextBoost + enabledBoost,
      matchKind: 'keyword',
    };
  }

  // Reasonable fuzzy subsequence match against title or primary keywords
  const fuzzyTitle = scoreFuzzySubsequence(titleLower, normalizedQuery);
  if (fuzzyTitle >= 0) {
    return {
      command,
      score: 1_000 + fuzzyTitle + contextBoost + enabledBoost,
      matchKind: 'fuzzy',
    };
  }

  for (const kw of keywordsLower) {
    const fuzzyKw = scoreFuzzySubsequence(kw, normalizedQuery);
    if (fuzzyKw >= 0) {
      return {
        command,
        score: 800 + fuzzyKw + contextBoost + enabledBoost,
        matchKind: 'fuzzy',
      };
    }
  }

  return null;
}

export function rankAndFilterCommands(
  commands: readonly AppCommand[],
  query: string,
  options?: {limit?: number}
): RankedCommand[] {
  const normalized = normalizeCommandQuery(query);
  const limit = options?.limit ?? 48;
  const matches: RankedCommand[] = [];

  for (const cmd of commands) {
    if (cmd.isAvailable === false) continue;
    const ranked = scoreCommandMatch(cmd, normalized);
    if (ranked) matches.push(ranked);
  }

  matches.sort((a, b) => {
    if (normalized) {
      if (b.score !== a.score) return b.score - a.score;
      const catA = CATEGORY_RANK.get(a.command.category) ?? 99;
      const catB = CATEGORY_RANK.get(b.command.category) ?? 99;
      if (catA !== catB) return catA - catB;
    } else {
      const catA = CATEGORY_RANK.get(a.command.category) ?? 99;
      const catB = CATEGORY_RANK.get(b.command.category) ?? 99;
      if (catA !== catB) return catA - catB;
      if (b.score !== a.score) return b.score - a.score;
    }
    const titleCmp = a.command.title.localeCompare(b.command.title);
    if (titleCmp !== 0) return titleCmp;
    return a.command.id.localeCompare(b.command.id);
  });

  return matches.slice(0, limit);
}

export interface CommandGroupSection {
  category: CommandCategory;
  items: RankedCommand[];
}

export function groupRankedCommands(
  ranked: readonly RankedCommand[]
): CommandGroupSection[] {
  const byCategory = new Map<CommandCategory, RankedCommand[]>();
  for (const item of ranked) {
    const cat = item.command.category;
    const arr = byCategory.get(cat);
    if (arr) arr.push(item);
    else byCategory.set(cat, [item]);
  }

  const sections: CommandGroupSection[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = byCategory.get(category);
    if (items && items.length > 0) {
      sections.push({category, items});
    }
  }
  return sections;
}
