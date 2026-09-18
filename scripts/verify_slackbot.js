#!/usr/bin/env node
/**
 * ==============================================================================
 * Team Monthly SlackBot - Comprehensive Quality Assurance (QA) Runner
 * ==============================================================================
 * 
 * Runs all quality, security, and integration checks:
 * 1. Linter (ESLint)
 * 2. TypeScript compilation (tsc)
 * 3. Unit tests (Jest)
 * 4. Zero-hardcoding & Security audit (detecting hardcoded secrets, staff numbers, credentials)
 * 5. Slack mrkdwn formatting invariant audit (detecting ・* or *： syntax traps)
 * 6. Live Cloud Run health check (optional/warning if offline)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function printHeader(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}============================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}🤖 ${title}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}============================================================${COLORS.reset}\n`);
}

function printStep(index, total, name) {
  process.stdout.write(`[${index}/${total}] ${name.padEnd(45, '.')} `);
}

function pass(msg = 'PASS ✅') {
  console.log(`${COLORS.green}${COLORS.bold}${msg}${COLORS.reset}`);
}

function fail(msg = 'FAIL ❌', details = '') {
  console.log(`${COLORS.red}${COLORS.bold}${msg}${COLORS.reset}`);
  if (details) {
    console.error(`\n${COLORS.red}${details}${COLORS.reset}\n`);
  }
}

function warn(msg = 'WARN ⚠️') {
  console.log(`${COLORS.yellow}${COLORS.bold}${msg}${COLORS.reset}`);
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.ts') || file.endsWith('.js')) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

async function run() {
  printHeader('Team Monthly SlackBot - Quality Assurance & Inspection');
  let hasErrors = false;
  const TOTAL_STEPS = 6;

  // --- Step 1: Linter ---
  printStep(1, TOTAL_STEPS, 'Running Linter (ESLint)');
  try {
    execSync('npm run lint', { stdio: 'pipe', encoding: 'utf8' });
    pass();
  } catch (err) {
    hasErrors = true;
    fail('FAIL ❌', err.stdout || err.stderr || err.message);
  }

  // --- Step 2: TypeScript Build ---
  printStep(2, TOTAL_STEPS, 'Building TypeScript (tsc)');
  try {
    execSync('npm run build', { stdio: 'pipe', encoding: 'utf8' });
    pass();
  } catch (err) {
    hasErrors = true;
    fail('FAIL ❌', err.stdout || err.stderr || err.message);
  }

  // --- Step 3: Jest Tests ---
  printStep(3, TOTAL_STEPS, 'Running Unit Tests (Jest)');
  try {
    const output = execSync('npm test', { stdio: 'pipe', encoding: 'utf8' });
    const match = output.match(/Test Suites:\s*([^\n]+)/);
    const summary = match ? match[1] : 'All passed';
    pass(`PASS ✅ (${summary})`);
  } catch (err) {
    hasErrors = true;
    fail('FAIL ❌', err.stdout || err.stderr || err.message);
  }

  // --- Step 4: Zero-Hardcoding Security Audit ---
  printStep(4, TOTAL_STEPS, 'Scanning for Hardcoded Secrets & Staff Info');
  const srcFiles = getAllFiles(path.join(__dirname, '..', 'src'));
  const suspiciousFindings = [];

  const secretPatterns = [
    { label: 'Slack Bot Token', regex: /xoxb-[0-9A-Za-z-]+/ },
    { label: 'Slack App Token', regex: /xapp-[0-9A-Za-z-]+/ },
    { label: 'Gemini API Key', regex: /AIzaSy[0-9A-Za-z-_]{33}/ },
    { label: 'RSA Private Key', regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/ },
  ];

  srcFiles.forEach((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(path.join(__dirname, '..'), file);

    // Check secrets
    secretPatterns.forEach((p) => {
      if (p.regex.test(content)) {
        suspiciousFindings.push(`[${p.label}] Found in ${relFile}`);
      }
    });

    // Check for hardcoded 6-digit staff numbers like '000101' outside of types/comments
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // Exclude comment lines or type definitions
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.includes('mock') || line.includes('staffNum?: string')) {
        return;
      }
      const staffNumMatch = line.match(/['"](00\d{4})['"]/);
      if (staffNumMatch) {
        suspiciousFindings.push(`[Hardcoded StaffNum: ${staffNumMatch[1]}] ${relFile}:${idx + 1}`);
      }
    });
  });

  if (suspiciousFindings.length === 0) {
    pass('PASS ✅ (0 leaked secrets/PII)');
  } else {
    hasErrors = true;
    fail('FAIL ❌', suspiciousFindings.join('\n'));
  }

  // --- Step 5: Slack mrkdwn Invariant Audit ---
  printStep(5, TOTAL_STEPS, 'Auditing Slack mrkdwn Formatting Rules');
  const mrkdwnIssues = [];

  srcFiles.forEach((file) => {
    // Only check files that generate or format Slack messages
    if (file.includes('ai\\gemini.ts') || file.includes('ai/gemini.ts')) return; // ignore sanitizer itself
    const content = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(path.join(__dirname, '..'), file);
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      // Ignore comment lines
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

      // Detect: ・* without space (e.g. `・*${name}*` or '・*')
      if (/・\*/.test(line)) {
        mrkdwnIssues.push(`[Invalid Bold after Bullet: '・*'] ${relFile}:${idx + 1} -> Insert space: '・ *'`);
      }
      // Detect: *： (asterisk immediately touching full-width colon)
      if (/\*：/.test(line)) {
        mrkdwnIssues.push(`[Invalid Closing Delimiter: '*：'] ${relFile}:${idx + 1} -> Convert to '*: '`);
      }
    });
  });

  if (mrkdwnIssues.length === 0) {
    pass('PASS ✅ (0 formatting traps)');
  } else {
    hasErrors = true;
    fail('FAIL ❌', mrkdwnIssues.join('\n'));
  }

  // --- Step 6: Live Cloud Run Health Check ---
  printStep(6, TOTAL_STEPS, 'Verifying Live Cloud Run Health (/health)');
  const healthUrl = process.env.CLOUD_RUN_HEALTH_URL || 'https://team-monthly-slackbot-819933730656.asia-northeast1.run.app/health';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.status === 'healthy') {
        pass('PASS ✅ (status: healthy)');
      } else {
        warn(`WARN ⚠️ (status: ${data.status})`);
      }
    } else {
      warn(`WARN ⚠️ (HTTP status ${res.status})`);
    }
  } catch (e) {
    warn(`SKIPPED ⚠️ (Service offline or network unavailable)`);
  }

  // --- Final Summary ---
  console.log(`\n${COLORS.bold}${COLORS.cyan}============================================================${COLORS.reset}`);
  if (hasErrors) {
    console.log(`${COLORS.bold}${COLORS.red}❌ QA VERIFICATION FAILED. Please resolve errors before pushing.${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.cyan}============================================================${COLORS.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${COLORS.bold}${COLORS.green}🎉 ALL QA CHECKS PASSED! Code is safe, robust, and deploy-ready.${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.cyan}============================================================${COLORS.reset}\n`);
    process.exit(0);
  }
}

run();
