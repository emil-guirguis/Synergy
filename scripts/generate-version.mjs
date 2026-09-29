#!/usr/bin/env node

/**
 * Generate Tesla-style version number: Year.Week.Build
 *
 * Format: YYYY.WW.B
 * - YYYY: Current year (e.g., 2025)
 * - WW: ISO week number (01-53)
 * - B: Commits on HEAD since the start of this ISO week
 *
 * Example: 2025.47.3 (Year 2025, Week 47, Build 3)
 *
 * B is derived from `git log`, not read-then-incremented from version.json.
 * The old scheme bumped whatever build number was last committed to
 * version.json, but nothing ever committed that bump back — every fresh
 * checkout (a second dev, a CI runner) started from the same stale value, so
 * local builds and CI/production builds drifted apart or collided instead of
 * advancing together. Deriving B from git history instead means any two
 * checkouts of the same commit — a laptop and a CI runner alike — compute the
 * identical number with no shared state and nothing to write back.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');

/**
 * Get ISO week number for a given date
 * @param {Date} date
 * @returns {number} Week number (1-53)
 */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

/** Monday 00:00 UTC of the ISO week containing `date`. */
function getIsoWeekStart(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  return d;
}

/**
 * Commits on HEAD since the start of this ISO week — a deterministic,
 * shared-nothing counter. Requires full history (a shallow clone with
 * `fetch-depth: 1` would undercount); falls back to 1 if git isn't
 * available or the checkout is shallow, rather than failing the build.
 */
function getBuildNumber(weekStart) {
  try {
    const out = execFileSync(
      'git',
      ['rev-list', '--count', `--since=${weekStart.toISOString()}`, 'HEAD'],
      { cwd: repoRoot, encoding: 'utf-8' }
    );
    const count = parseInt(out.trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 1;
  } catch (error) {
    console.warn('Could not compute build number from git history, defaulting to 1:', error.message);
    return 1;
  }
}

/**
 * Generate version string
 * @returns {string} Version in format YYYY.WW.B
 */
function generateVersion() {
  const now = new Date();
  const year = now.getFullYear();
  const week = getWeekNumber(now).toString().padStart(2, '0');
  const buildNumber = getBuildNumber(getIsoWeekStart(now));

  const version = `${year}.${week}.${buildNumber}`;

  // Written for informational/debugging use (e.g. docker-publish.yml reads it
  // back for a tag) — no longer the source of truth for the next build's
  // number, so it's fine for this file to be stale or uncommitted.
  const versionData = {
    version,
    year,
    week: parseInt(week),
    build: buildNumber,
    timestamp: now.toISOString(),
    date: now.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  };

  fs.writeFileSync(path.join(repoRoot, 'version.json'), JSON.stringify(versionData, null, 2));

  console.log(`✅ Generated version: ${version}`);
  console.log(`   Year: ${year}, Week: ${week}, Build: ${buildNumber}`);
  console.log(`   Timestamp: ${versionData.date}`);

  return version;
}

// Run if called directly
generateVersion();

export { generateVersion, getWeekNumber, getIsoWeekStart };
