// File: backend/scripts/shared/timeUtilsBackend.js

/**
 * ✅ Backend-safe time utils for ET time handling.
 * These do NOT rely on Luxon or frontend-only modules.
 */

export function nowET() {
  return new Date();
}

export function todayET() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function currentTimeET() {
  return new Date().toTimeString().slice(0, 5); // HH:MM
}
