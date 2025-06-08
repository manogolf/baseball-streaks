// 📁 Pure function-based prop value derivation
// No Supabase, no fetch — fully testable and importable

// 🚀 Normalized keys: "hits", "triples", "strikeouts_pitching", etc.
export const STAT_FIELD_MAP = {
  hits: (s) => s?.hits ?? null,

  singles: (s) => {
    const hits = s?.hits ?? null;
    const doubles = s?.doubles ?? null;
    const triples = s?.triples ?? null;
    const homeRuns = s?.homeRuns ?? null;

    if (
      [hits, doubles, triples, homeRuns].every(
        (v) => typeof v === "number" && !isNaN(v)
      )
    ) {
      return hits - doubles - triples - homeRuns;
    }
    return null;
  },

  doubles: (s) => s?.doubles ?? null,
  triples: (s) => s?.triples ?? null,
  home_runs: (s) => s?.homeRuns ?? null,
  walks: (s) => {
    console.log("🧪 WALK EXTRACTOR CALLED WITH:", s && s.baseOnBalls);
    if (!s || typeof s.baseOnBalls !== "number") return null;
    return s.baseOnBalls;
  },

  strikeouts_batting: (s) => s?.strikeOuts ?? null,
  stolen_bases: (s) => s?.stolenBases ?? null,
  rbis: (s) => s?.rbi ?? null,
  runs_scored: (s) => s?.runs ?? null,

  total_bases: (s) => {
    const hits = s?.hits ?? null;
    const doubles = s?.doubles ?? null;
    const triples = s?.triples ?? null;
    const homeRuns = s?.homeRuns ?? null;

    if (
      [hits, doubles, triples, homeRuns].every(
        (v) => typeof v === "number" && !isNaN(v)
      )
    ) {
      const singles = hits - doubles - triples - homeRuns;
      return singles * 1 + doubles * 2 + triples * 3 + homeRuns * 4;
    }
    return null;
  },

  hits_runs_rbis: (s) => {
    const { hits, runs, rbi } = s ?? {};
    if ([hits, runs, rbi].every((v) => typeof v === "number" && !isNaN(v))) {
      return hits + runs + rbi;
    }
    return null;
  },

  runs_rbis: (s) => {
    const { runs, rbi } = s ?? {};
    if ([runs, rbi].every((v) => typeof v === "number" && !isNaN(v))) {
      return runs + rbi;
    }
    return null;
  },

  // ✅ Pitching stats
  strikeouts_pitching: (s) => s?.strikeOuts ?? null,
  walks_allowed: (s) => s?.baseOnBalls ?? null,
  hits_allowed: (s) => s?.hits ?? null,
  earned_runs: (s) => s?.earnedRuns ?? null,
  outs_recorded: (s) => {
    const ip = s?.inningsPitched;
    return typeof ip === "number" && !isNaN(ip) ? Math.round(ip * 3) : null;
  },
};

// ✅ Derive value based on normalized propType
export function derivePropValue(stats = {}, normalizedPropType) {
  const extractor = STAT_FIELD_MAP[normalizedPropType];
  if (!extractor) return null;

  try {
    const value = extractor(stats);
    return typeof value === "number" && !isNaN(value) ? value : null;
  } catch {
    return null;
  }
}
