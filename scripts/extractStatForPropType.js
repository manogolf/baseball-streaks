import { propExtractors } from "../backend/scripts/shared/propUtils.js"; // adjust path if needed

const stats = {
  atBats: 3,
  runs: 1,
  hits: 1,
  baseOnBalls: 1,
  strikeOuts: 1,
};

// For example, to test 'runs_scored':
const propType = "runs_scored";
const value = propExtractors[propType]?.(stats);

console.log(`Extracted value for ${propType}:`, value);
