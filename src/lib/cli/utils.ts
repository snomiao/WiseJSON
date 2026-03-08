/**
 * cli/utils.ts
 * Utility functions for the WiseJSON Command Line Interface.
 */

import readline from 'readline';
import logger from '../logger.js';

/**
 * Interface representing parsed CLI options.
 */
export interface CliOptions {
  [key: string]: string | boolean | undefined;
}

/**
 * Advanced command line argument parser.
 * Separates positional arguments from named flags and options.
 * Correcty handles values containing '=' and supports --flag or --option=value.
 * * @param rawCliArgs - The array from process.argv.slice(2).
 * @returns An object containing positional 'args' and named 'options'.
 */
export function parseArgs(rawCliArgs: string[]): { args: string[]; options: CliOptions } {
  const options: CliOptions = {};
  const args: string[] = [];

  for (const arg of rawCliArgs) {
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      // Everything after the first '=' is considered the value.
      const value = parts.slice(1).join('=');

      // Flag without value (e.g., --force, --unique)
      if (value === '') {
        options[key] = true;
      } else {
        // Option with value (e.g., --limit=10)
        options[key] = value;
      }
    } else {
      // Positional argument
      args.push(arg);
    }
  }
  return { args, options };
}

/**
 * Interface for error formatting options.
 */
interface PrettyErrorOptions {
  json?: boolean;
  code?: number;
}

/**
 * Outputs a formatted error message and terminates the process.
 * * @param msg - The error message to display.
 * @param options - Configuration for output format and exit code.
 */
export function prettyError(msg: string, { json = false, code = 1 }: PrettyErrorOptions = {}): void {
  if (json) {
    console.error(JSON.stringify({ error: true, message: msg, code }));
  } else {
    logger.error(msg);
  }
  process.exit(code);
}

/**
 * Requests user confirmation in interactive mode.
 * Automatically resolves to true if 'force' or 'yes' flags are present.
 * * @param prompt - The question to ask the user.
 * @param options - The options object retrieved from parseArgs.
 * @returns A promise that resolves to a boolean representing the user's choice.
 */
export async function confirmAction(prompt: string, options: CliOptions): Promise<boolean> {
  // Shortcut if bypass flags are provided
  if (options['force'] || options['yes']) {
    return true;
  }

  // In non-interactive environments (e.g., execSync in tests or CI),
  // blocking for input would hang the process. Default to safe 'false'.
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(`${prompt} [y/N] `, (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}
