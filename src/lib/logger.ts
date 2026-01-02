/**
 * wise-json/logger.ts
 * Strongly typed logging utility with color support and level filtering.
 */
import { LogLevelName, colorMap, colors, levels } from "./types.js";

// --- Configuration ---
const envLevel = process.env["LOG_LEVEL"]?.toLowerCase();
const defaultLogLevel: LogLevelName = process.env["NODE_ENV"] === 'production' ? 'warn' : 'log';

let currentLevelThreshold: number;

if (envLevel === 'none') {
    currentLevelThreshold = -1;
} else {
    currentLevelThreshold = envLevel && levels[envLevel as LogLevelName] !== undefined
        ? levels[envLevel as LogLevelName]
        : levels[defaultLogLevel];
}

const NO_COLOR = process.env["LOG_NO_COLOR"] === 'true';

/**
 * Safely converts arguments of any type to a readable string.
 */
function safeArgsToString(args: any[]): string {
    try {
        return args.map(arg => {
            if (arg instanceof Error) return arg.stack || arg.message;
            if (typeof arg === 'object' && arg !== null) {
                try {
                    return JSON.stringify(arg);
                } catch (e) {
                    return '[Unserializable Object]';
                }
            }
            return String(arg);
        }).join(" ");
    } catch (e) {
        console.error('[Logger Internal Error] Failed to process arguments for logging:', e);
        return '[Error processing log arguments]';
    }
}

/**
 * Formats the log message with timestamps and ANSI colors.
 */
function format(level: LogLevelName, msg: string): string {
    const ts = new Date().toISOString();
    if (NO_COLOR) {
        return `[${ts}] [${level.toUpperCase()}] ${msg}`;
    }
    const color = colorMap[level] || colors.reset;
    return `${color}[${ts}] [${level.toUpperCase()}]${colors.reset} ${msg}`;
}



export const logger = {
  // Check the level BEFORE calling console
    error(...args: any[]): void {
        if (currentLevelThreshold >= levels.error) {
            console.error(format("error", safeArgsToString(args)));
        }
    },

    warn(...args: any[]): void {
        if (currentLevelThreshold >= levels.warn) {
            console.log(format("warn", safeArgsToString(args)));
        }
    },

    log(...args: any[]): void {
        if (currentLevelThreshold >= levels.log) {
            console.log(format("log", safeArgsToString(args)));
        }
    },

    debug(...args: any[]): void {
        if (currentLevelThreshold >= levels.debug) {
            console.log(format("debug", safeArgsToString(args)));
        }
    },

    getLevel(): LogLevelName | 'none' {
        return (Object.keys(levels).find(k => levels[k as LogLevelName] === currentLevelThreshold) as LogLevelName) || 'none';
    },

   // Use Object.freeze to ensure the levels cannot be modified at runtime
    levels: Object.freeze({ ...levels })
};

export default logger;
