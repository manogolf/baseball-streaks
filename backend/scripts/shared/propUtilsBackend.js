// File: backend/scripts/shared/propUtilsBackend.js

import { derivePropValue } from "../resolution/derivePropValue.js";

/**
 * Wrapper to extract a prop value from player stats.
 * Used only in backend.
 */
export function extractStatForPropType(propType, stats) {
  return derivePropValue(propType, stats);
}
