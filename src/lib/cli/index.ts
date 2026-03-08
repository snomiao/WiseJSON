#!/usr/bin/env node

/**
 * cli/index.ts
 * Main entry point for the WiseJSON CLI.
 * Coordinates command routing, security checks, and database lifecycle.
 */

import path from 'path';
import { actions as commandRegistry } from './actions.js';
import { parseArgs, prettyError, CliOptions } from './utils.js';
import { WiseJSON } from '../../index.js';

/**
 * The root directory where database files are stored.
 * Resolved from WISE_JSON_PATH or defaults to a local data folder.
 */
const DB_PATH: string = process.env['WISE_JSON_PATH'] || path.resolve(process.cwd(), 'wise-json-db-data');

/**
 * Prints the usage guide and available commands to the console.
 */
function printHelp(): void {
  console.log('WiseJSON DB Unified CLI\n');
  console.log('Usage: wise-json <command> [args...] [--options...]\n');
  console.log('Global Options:');
  console.log('  --allow-write    Required for any command that modifies data.');
  console.log('  --force, --yes   Skip confirmation prompts for dangerous operations.');
  console.log('  --json-errors    Output errors in JSON format.');
  console.log('  --help           Show this help message.\n');
  console.log('Available Commands:');

  const commands = Object.entries(commandRegistry);
  const maxLen = Math.max(...commands.map(([name]) => name.length));

  commands.forEach(([name, { description }]) => {
    console.log(`  ${name.padEnd(maxLen + 2)} ${description || ''}`);
  });
}

/**
 * Execution pipeline: parses arguments, initializes DB, and routes to action handlers.
 */
async function main(): Promise<void> {
  console.log("CLI ARGS, ", process.argv)
  const allCliArgs = process.argv.slice(2);
  const { args, options } = parseArgs(allCliArgs);
  const commandName = args.shift();

  // Show help if no command is provided or help flag is set
  if (!commandName || options['help']) {
    printHelp();
    return;
  }

  const command = commandRegistry[commandName];
  if (!command) {
    return prettyError(`Unknown command: "${commandName}". Use --help for usage.`);
  }

  // Security Guard: Prevent accidental data modification
  if (command.isWrite && !options['allow-write']) {
    return prettyError(`Write command "${commandName}" requires the --allow-write flag to confirm changes.`);
  }

  // Initialize DB instance
  // We disable auto-cleanup tasks for CLI operations to ensure fast execution
  const db = new WiseJSON(DB_PATH, {
    ttlCleanupIntervalMs: 0,
    checkpointIntervalMs: 0,
  });

  try {
    await db.init();
    // Route control to the specific action handler
    await command.handler(db, args, options);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

// Global error handler for unhandled rejections and async errors
main().catch((err: Error) => {
  const jsonErrors = process.argv.slice(2).includes('--json-errors');
  prettyError(err.message, { json: jsonErrors });
});
