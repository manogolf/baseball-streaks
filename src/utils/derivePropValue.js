// src/utils/derivePropValue.js

export const STAT_FIELD_MAP = {
  hits: (stats) => stats?.batting?.hits ?? 0,
  home_runs: (stats) => stats?.batting?.home_runs ?? 0,
  rbis: (stats) => stats?.batting?.rbis ?? 0,
  runs_scored: (stats) => stats?.batting?.runs_scored ?? 0,
  strikeouts_batting: (stats) => stats?.batting?.strikeouts_batting ?? 0,
  walks: (stats) => stats?.batting?.walks ?? 0,
  doubles: (stats) => stats?.batting?.doubles ?? 0,
  triples: (stats) => stats?.batting?.triples ?? 0,
  stolen_bases: (stats) => stats?.batting?.stolen_bases ?? 0,

  strikeouts_pitching: (stats) => stats?.pitching?.strikeouts_pitching ?? 0,
  earned_runs: (stats) => stats?.pitching?.earned_runs ?? 0,
  hits_allowed: (stats) => stats?.pitching?.hits_allowed ?? 0,
  walks_allowed: (stats) => stats?.pitching?.walks_allowed ?? 0,
  outs_recorded: (stats) => {
    const outs = stats?.pitching?.outs ?? 0;
    return Math.floor(outs);
  },

  total_bases: (stats) => {
    const {
      doubles = 0,
      triples = 0,
      home_runs = 0,
      hits = 0,
    } = stats?.batting ?? {};
    const singles = hits - (doubles + triples + home_runs);
    return singles * 1 + doubles * 2 + triples * 3 + home_runs * 4;
  },

  singles: (stats) => {
    const {
      hits = 0,
      doubles = 0,
      triples = 0,
      home_runs = 0,
    } = stats?.batting ?? {};
    return hits - doubles - triples - home_runs;
  },

  runs_rbis: (stats) => {
    const runs_scored = stats?.batting?.runs_scored ?? 0;
    const rbis = stats?.batting?.rbis ?? 0;
    return runs_scored + rbis;
  },

  hits_runs_rbis: (stats) => {
    const hits = stats?.batting?.hits ?? 0;
    const runs_scored = stats?.batting?.runs_scored ?? 0;
    const rbis = stats?.batting?.rbis ?? 0;
    return hits + runs_scored + rbis;
  },
};

export function derivePropValue(stats, propType) {
  const fn = STAT_FIELD_MAP[propType];
  if (!fn) {
    console.warn(`⚠️ No stat derivation function for propType: ${propType}`);
    return null;
  }
  return fn(stats);
}
