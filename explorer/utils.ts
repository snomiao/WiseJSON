/**
 * explorer/utils.ts
 * Formatting and security utilities for the WiseJSON Data Explorer and CLI output.
 */

/**
 * ANSI Escape codes for terminal styling.
 */
const ansi = {
  reset: '\x1b[0m',
  key: '\x1b[34m',       // Blue for keys
  string: '\x1b[32m',    // Green for strings
  number: '\x1b[33m',    // Yellow for numbers
  boolean: '\x1b[35m',   // Purple for booleans
  null: '\x1b[90m',      // Gray for null values
} as const;

/**
 * Applies ANSI color coding to a JSON string for enhanced readability in the terminal.
 * * @param jsonString - The raw JSON string to colorize.
 * @returns A string containing ANSI escape sequences for terminal coloring.
 */
export function colorizeJson(jsonString: string): string {
  return jsonString
    // Colorize Keys: "key":
    .replace(/"([^"]+)":/g, `"${ansi.key}$1${ansi.reset}":`)
    // Colorize Strings (avoiding keys already matched)
    .replace(/"([^"]*)"/g, (match, p1) => {
      if (match.endsWith('":')) return match;
      return `"${ansi.string}${p1}${ansi.reset}"`;
    })
    // Colorize Numbers
    .replace(/\b(-?\d+(\.\d+)?)\b/g, `${ansi.number}$1${ansi.reset}`)
    // Colorize Booleans
    .replace(/\b(true|false)\b/g, `${ansi.boolean}$1${ansi.reset}`)
    // Colorize Nulls
    .replace(/\b(null)\b/g, `${ansi.null}$1${ansi.reset}`);
}

/**
 * Escapes special HTML characters to prevent XSS (Cross-Site Scripting)
 * when rendering database content in the Explorer web interface.
 * * @param str - The string to be escaped.
 * @returns The HTML-safe string.
 */
export function escapeHtml(str: any): string {
  if (typeof str !== 'string') return String(str);

  const htmlMap: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return str.replace(/[&<>"']/g, (m) => htmlMap[m]);
}
