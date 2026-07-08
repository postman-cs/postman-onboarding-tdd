import { describe, expect, it } from 'vitest';

import { renderJUnit } from '../src/reporting/junit.js';
import type { LedgerSummary } from '../src/types.js';

describe('renderJUnit', () => {
  const summary: LedgerSummary = {
    failing: 1,
    packets: [
      { key: 'getWidgets', passes: true, title: 'GET /v1/widgets' },
      { key: 'createWidget', passes: true, title: 'POST /v1/widgets' },
      { key: 'deleteWidget', lastFailureFingerprint: 'abcdef0123456789', passes: false, title: 'DELETE /v1/widgets/{id}' }
    ],
    passing: 2,
    total: 3
  };

  it('produces valid JUnit XML with tests=3 failures=1 and one <failure> element', () => {
    const xml = renderJUnit(summary);
    expect(xml).toContain('<testsuite name="postman-tdd" tests="3" failures="1">');
    expect(xml).toContain('<testcase classname="getWidgets" name="GET /v1/widgets"/>');
    expect(xml).toContain('<testcase classname="createWidget" name="POST /v1/widgets"/>');
    expect(xml).toContain('<testcase classname="deleteWidget" name="DELETE /v1/widgets/{id}">');
    // Exactly one <failure> element (the failing packet).
    const failureCount = (xml.match(/<failure /g) || []).length;
    expect(failureCount).toBe(1);
    // The failure message carries the title + fingerprint slice.
    expect(xml).toContain('DELETE /v1/widgets/{id} [abcdef012345]');
    expect(xml).toContain('</testcase>');
    expect(xml).toContain('</testsuite>');
    expect(xml.endsWith('\n')).toBe(true);
  });

  it('escapes XML-special characters in packet titles and keys', () => {
    const special: LedgerSummary = {
      failing: 1,
      packets: [
        { key: 'op<&>"\'', lastFailureFingerprint: 'fp', passes: false, title: '<script>"weird"&</script>' }
      ],
      passing: 0,
      total: 1
    };
    const xml = renderJUnit(special);
    // Raw special chars must NOT appear inside attribute values.
    expect(xml).not.toContain('<script>"weird"');
    // Escaped forms must be present.
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&quot;weird&quot;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&apos;');
    // Still well-formed: the <testcase> opening tag is intact.
    expect(xml).toContain('<testcase ');
    expect(xml).toContain('</testcase>');
  });

  it('is stable across two calls (deterministic)', () => {
    const a = renderJUnit(summary);
    const b = renderJUnit(summary);
    expect(a).toBe(b);
  });

  it('produces bare testcases (no <failure>) for an all-passing ledger', () => {
    const allPass: LedgerSummary = {
      failing: 0,
      packets: [{ key: 'op1', passes: true, title: 'op1' }],
      passing: 1,
      total: 1
    };
    const xml = renderJUnit(allPass);
    expect(xml).toContain('tests="1" failures="0"');
    expect(xml).not.toContain('<failure');
    expect(xml).toContain('<testcase classname="op1" name="op1"/>');
  });

  it('produces a well-formed root element (opening + closing tags match)', () => {
    const xml = renderJUnit(summary);
    // Basic well-formedness: single root <testsuite>, closing tag present.
    const openCount = (xml.match(/<testsuite /g) || []).length;
    const closeCount = (xml.match(/<\/testsuite>/g) || []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
    // Every non-self-closing <testcase ...> has a matching </testcase>.
    // Self-closing tags end with "/>"; open tags end with ">" (not "/>").
    const selfClosing = (xml.match(/<testcase [^>]*\/>/g) || []).length;
    const allOpenings = (xml.match(/<testcase /g) || []).length;
    const openTestcases = allOpenings - selfClosing;
    const closeTestcases = (xml.match(/<\/testcase>/g) || []).length;
    expect(openTestcases).toBe(closeTestcases);
  });

  it('honors a custom suite name', () => {
    const xml = renderJUnit(summary, { suiteName: 'custom-suite' });
    expect(xml).toContain('name="custom-suite"');
  });
});
