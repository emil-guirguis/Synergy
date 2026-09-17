#!/usr/bin/env node

/**
 * Generate Tesla-style version number: Year.Week.Build
 * 
 * Format: YYYY.WW.B
 * - YYYY: Current year (e.g., 2025)
 * - WW: ISO week number (01-53)
 * - B: Build number (increments for each build in the same week)
 * 
 * Example: 2025.47.3 (Year 2025, Week 47, Build 3)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/**
 * Generate version string
 * @returns {string} Version in format YYYY.WW.B
 */
function generateVersion() {
  const now = new Date();
  const year = now.getFullYear();
  const week = getWeekNumber(now).toString().padStart(2, '0');

  // CI passes VERSION_BUILD_OVERRIDE (e.g. $GITHUB_RUN_NUMBER) so a deploy's
  // build number is monotonic across runs. version.json is committed to the
  // repo, but no deploy workflow writes its bump back — every ephemeral CI
  // checkout starts from the same stale committed value, so the file-based
  // increment below collides across separate deploys instead of advancing.
  // A GitHub Actions run number has no such problem: it only goes up.
  const versionFilePath = path.join(__dirname, '..', 'version.json');
  const override = process.env.VERSION_BUILD_OVERRIDE;
  let buildNumber = override ? parseInt(override, 10) : 1;

  if (!override) {
    // Read existing version file if it exists
    if (fs.existsSync(versionFilePath)) {
      try {
        const existingVersion = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
        const [existingYear, existingWeek] = existingVersion.version.split('.');

        // If same year and week, increment build number
        if (existingYear === year.toString() && existingWeek === week) {
          buildNumber = parseInt(existingVersion.build || 1) + 1;
        }
      } catch (error) {
        console.warn('Could not read existing version file, starting fresh:', error.message);
      }
    }
  }

  const version = `${year}.${week}.${buildNumber}`;
  
  // Write version file
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
  
  fs.writeFileSync(versionFilePath, JSON.stringify(versionData, null, 2));
  
  console.log(`✅ Generated version: ${version}`);
  console.log(`   Year: ${year}, Week: ${week}, Build: ${buildNumber}`);
  console.log(`   Timestamp: ${versionData.date}`);
  
  return version;
}

// Run if called directly
generateVersion();

export { generateVersion, getWeekNumber };
