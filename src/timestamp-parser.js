/**
 * Sundial Timestamp Parser
 * Parse Unix timestamps with timezone support
 */

var SECOND_THRESHOLD = 10000000000;      // 10 digits = seconds
var MILLISECOND_THRESHOLD = 10000000000000; // 13 digits = milliseconds

/**
 * Parse a timestamp string into human-readable date
 * @param {string} text - Input text (timestamp number or text containing one)
 * @param {number} [tzOffsetHours=8] - Timezone offset in hours (e.g. 8 for CST, -5 for EST)
 * @returns {object|null} Parsed result or null
 */
function parseTimestamp(text, tzOffsetHours) {
  if (!text || typeof text !== 'string') return null;

  // Default to UTC+8 (Beijing/Shanghai)
  var tzOffset = (typeof tzOffsetHours === 'number') ? tzOffsetHours : 8;
  var tzMs = tzOffset * 60 * 60 * 1000;

  // Extract numeric part (supports embedded timestamps like "ts=1713153600 end")
  var numMatch = text.match(/(\d{9,13})/);
  if (!numMatch) return null;

  var ts = parseInt(numMatch[1], 10);

  // Determine seconds vs milliseconds
  var tsMs, isMs;
  if (ts > MILLISECOND_THRESHOLD) return null;
  else if (ts > SECOND_THRESHOLD) { tsMs = ts; isMs = true; }
  else if (ts > 0) { tsMs = ts * 1000; isMs = false; }
  else return null;

  // Convert to Date
  var date = new Date(tsMs);
  if (isNaN(date.getTime())) return null;
  if (date.getFullYear() < 1970 || date.getFullYear() > 2100) return null;

  // Format with target timezone
  var result = formatWithTimezone(date, ts, tsMs, isMs, tzOffset);
  result.relative = getRelativeTime(date);

  return result;
}

/**
 * Format date with specific timezone offset
 */
function formatWithTimezone(date, original, ms, isMs, tzOffsetHours) {
  var pad = function(n) { return String(n).padStart(2, '0'); };
  var tzMs = tzOffsetHours * 60 * 60 * 1000;

  // Adjust date for timezone display
  var localDate = new Date(date.getTime() + tzMs + (date.getTimezoneOffset() * 60000));

  var yyyy = localDate.getFullYear();
  var MM = pad(localDate.getMonth() + 1);
  var dd = pad(localDate.getDate());
  var HH = pad(localDate.getHours());
  var mm = pad(localDate.getMinutes());
  var ss = pad(localDate.getSeconds());
  var SSS = isMs ? '.' + String(ms % 1000).padStart(3, '0') : '';

  var tzSign = tzOffsetHours >= 0 ? '+' : '';
  var tzLabel = 'UTC' + tzSign + tzOffsetHours;

  return {
    original: String(original),
    type: isMs ? 'ms' : 'sec',
    datetime: yyyy + '-' + MM + '-' + dd + ' ' + HH + ':' + mm + ':' + ss + SSS,
    date: yyyy + '-' + MM + '-' + dd,
    time: HH + ':' + mm + ':' + ss + SSS,
    iso: date.toISOString(),
    unix: Math.floor(ms / 1000),
    unixMs: ms,
    rawDate: date,
    // New fields for timezone display
    tzOffsetHours: tzOffsetHours,
    tzLabel: tzLabel,
    utcDatetime: date.toISOString().replace('T', ' ').replace('Z', '')
  };
}

/**
 * Relative time description (English)
 */
function getRelativeTime(date) {
  var now = new Date();
  var diff = now.getTime() - date.getTime();
  var absDiff = Math.abs(diff);

  var sec = Math.floor(absDiff / 1000);
  var min = Math.floor(sec / 60);
  var hr = Math.floor(min / 60);
  var day = Math.floor(hr / 24);
  var month = Math.floor(day / 30);
  var yr = Math.floor(day / 365);

  var ago = diff > 0 ? 'ago' : 'from now';

  if (yr > 0) return yr + 'y ' + ago;
  if (month > 0) return month + 'mo ' + ago;
  if (day > 0) return day + 'd ' + ago;
  if (hr > 0) return hr + 'h ' + ago;
  if (min > 0) return min + 'm ' + ago;
  if (sec > 0) return sec + 's ' + ago;
  return 'just now';
}

module.exports = { parseTimestamp: parseTimestamp, getRelativeTime: getRelativeTime };
