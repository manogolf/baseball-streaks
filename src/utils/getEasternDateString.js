// src/utils/getEasternDateString.js
import { DateTime } from 'luxon';

export const getEasternDateString = () => {
  return DateTime.now().setZone('America/New_York').toISODate(); // returns "YYYY-MM-DD"
};
