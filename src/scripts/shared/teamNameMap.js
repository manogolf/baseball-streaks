// src/scripts/shared/teamNameMap.js

// Map of team abbreviations to full names
export const teamNameMap = {
  ATH: "Athletics",
  ATL: "Atlanta Braves",
  AZ: "Arizona Diamondbacks",
  BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox",
  CHC: "Chicago Cubs",
  CWS: "Chicago White Sox",
  CIN: "Cincinnati Reds",
  CLE: "Cleveland Guardians",
  COL: "Colorado Rockies",
  DET: "Detroit Tigers",
  HOU: "Houston Astros",
  KC: "Kansas City Royals",
  LAA: "Los Angeles Angels",
  LAD: "Los Angeles Dodgers",
  MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers",
  MIN: "Minnesota Twins",
  NYM: "New York Mets",
  NYY: "New York Yankees",
  PHI: "Philadelphia Phillies",
  PIT: "Pittsburgh Pirates",
  SD: "San Diego Padres",
  SEA: "Seattle Mariners",
  SF: "San Francisco Giants",
  STL: "St. Louis Cardinals",
  TB: "Tampa Bay Rays",
  TEX: "Texas Rangers",
  TOR: "Toronto Blue Jays",
  WSH: "Washington Nationals",
};

// Utility function to get full name from abbreviation
export const getFullTeamName = (abbr) => {
  // Normalize special cases
  if (["OAK", "LV", "VIL"].includes(abbr)) return "Athletics";

  return teamNameMap[abbr] || abbr;
};
