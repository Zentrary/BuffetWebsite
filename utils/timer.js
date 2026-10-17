// Import the default session length for callers that use the configured duration.
const { SESSION_DURATION } = require('../config/constants');

/**
 * Calculate a session end Date using its start time and duration in minutes.
 * @param {Date|string|number} startTime - Session start time.
 * @param {number} durationMinutes - Session duration in minutes.
 * @returns {Date} Calculated end time.
 */
function calculateEndTime(startTime, durationMinutes = SESSION_DURATION) {
  return new Date(new Date(startTime).getTime() + durationMinutes * 60 * 1000);
}

/**
 * Calculate the non-negative time remaining until a session ends.
 * @param {Date|string|number} endTime - Session expiry time.
 * @returns {{hours: number, minutes: number, seconds: number, isExpired: boolean}} Remaining time parts.
 */
function getRemainingTime(endTime) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000)
  );
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;

  return {
    hours,
    minutes,
    seconds,
    isExpired: remainingSeconds === 0,
  };
}

/**
 * Check whether an end time has passed.
 * @param {Date|string|number} endTime - Session expiry time.
 * @returns {boolean} True when the end time is now or in the past.
 */
function isExpired(endTime) {
  return new Date() >= new Date(endTime);
}

// Export session timing helpers for session and customer workflows.
module.exports = { calculateEndTime, getRemainingTime, isExpired };
