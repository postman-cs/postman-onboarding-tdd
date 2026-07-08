import type { LedgerSummary } from '../types.js';

/**
 * D16: pure, IO-free JUnit XML renderer.
 *
 * Produces a single `<testsuite>` with one `<testcase>` per ledger packet.
 * Failing packets (passes===false) carry a `<failure>` element whose message
 * is the packet title + lastFailureFingerprint (XML-escaped). Passing packets
 * are bare testcases. The `tests`/`failures` attrs on `<testsuite>` mirror
 * the ledger counts. Deterministic ordering follows the packet array order.
 *
 * The string is written to `.postman-tdd/junit.xml` by the index run path so
 * it rides the existing agent-context artifact upload (no new artifact
 * client). Compatible with dorny/test-reporter + step-security/test-reporter.
 * SARIF is deferred (plan).
 */

const SUITE_NAME_DEFAULT = 'postman-tdd';

/**
 * Escapes the five XML-special characters for attribute and text content.
 * `&` is escaped first so it does not double-escape the other entities.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderJUnit(ledger: LedgerSummary, opts?: { suiteName?: string }): string {
  const suiteName = escapeXml(opts?.suiteName ?? SUITE_NAME_DEFAULT);
  const total = ledger.total;
  const failures = ledger.failing;
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="${suiteName}" tests="${total}" failures="${failures}">`
  ];
  for (const packet of ledger.packets) {
    const classname = escapeXml(packet.key);
    const name = escapeXml(packet.title);
    if (packet.passes) {
      lines.push(`  <testcase classname="${classname}" name="${name}"/>`);
    } else {
      const fingerprint = packet.lastFailureFingerprint ? ` [${packet.lastFailureFingerprint.slice(0, 12)}]` : '';
      const message = escapeXml(`${packet.title}${fingerprint}`);
      lines.push(`  <testcase classname="${classname}" name="${name}">`);
      lines.push(`    <failure message="${message}">contract assertion failed</failure>`);
      lines.push(`  </testcase>`);
    }
  }
  lines.push(`</testsuite>`);
  return `${lines.join('\n')}\n`;
}
