import { describe, expect, it } from 'vitest';
import {
  extractFindings,
  isSupportedDocumentName,
  parseReportDate,
  resolveAnatomicalMention
} from '../src/documents/extractor.js';

const parts = {
  'Femur.l': { baseName: 'Femur', side: 'left', latinName: 'Os femoris' },
  'Femur.r': { baseName: 'Femur', side: 'right', latinName: 'Os femoris' },
  'Patella.l': { baseName: 'Patella', side: 'left', latinName: '' },
  'Patella.r': { baseName: 'Patella', side: 'right', latinName: '' }
};

describe('supported document formats', () => {
  it('accepts plain text and Markdown only', () => {
    expect(isSupportedDocumentName('report.TXT')).toBe(true);
    expect(isSupportedDocumentName('report.md')).toBe(true);
    expect(isSupportedDocumentName('report.pdf')).toBe(false);
    expect(isSupportedDocumentName('scan.docx')).toBe(false);
  });
});

describe('parseReportDate', () => {
  it('reads ISO report dates', () => {
    expect(parseReportDate('Report date: 2026-03-14')).toBe('2026-03-14');
  });

  it('normalises day-first dates', () => {
    expect(parseReportDate('Date: 14/03/2026')).toBe('2026-03-14');
  });
});

describe('resolveAnatomicalMention', () => {
  it('resolves a specific mention to its stable, side-specific mesh ID', () => {
    expect(resolveAnatomicalMention('Pain in the left femur', parts)).toEqual({
      type: 'structure',
      label: 'Femur (left)',
      partIds: ['Femur.l']
    });
  });

  it('accepts an exact stable mesh ID during location editing', () => {
    expect(resolveAnatomicalMention('Femur.l', parts)).toEqual({
      type: 'structure',
      label: 'Femur (left)',
      partIds: ['Femur.l']
    });
  });

  it('does not turn a knee-region mention into a patella finding', () => {
    expect(resolveAnatomicalMention('Pain around the left knee', parts)).toEqual({
      type: 'region',
      id: 'knee',
      side: 'left',
      label: 'Left knee'
    });
  });

  it('does not assign a bilateral structure when laterality is absent', () => {
    expect(resolveAnatomicalMention('Femur pain', parts)).toEqual({
      type: 'structure',
      label: 'Femur (side not specified)',
      partIds: [],
      ambiguous: true,
      candidatePartIds: ['Femur.l', 'Femur.r']
    });
  });

  it('proposes candidates without assigning a finding that mentions multiple structures', () => {
    expect(resolveAnatomicalMention('Left patella pain and right femur pain', parts)).toEqual({
      type: 'structure',
      label: 'Multiple structures mentioned',
      partIds: [],
      ambiguous: true,
      candidatePartIds: ['Patella.l', 'Femur.r']
    });
  });

  it('does not guess when both sides of the same structure are documented', () => {
    const finding = resolveAnatomicalMention('Pain in the left and right femur', parts);
    expect(finding.ambiguous).toBe(true);
    expect(finding.partIds).toEqual([]);
    expect(finding.candidatePartIds).toEqual(['Femur.l', 'Femur.r']);
  });

  it('does not map laterality to an atlas part that belongs to the opposite side', () => {
    const finding = resolveAnatomicalMention('Right femur pain', {
      'Femur.l': { baseName: 'Femur', side: 'left' }
    });
    expect(finding.ambiguous).toBe(true);
    expect(finding.partIds).toEqual([]);
    expect(finding.candidatePartIds).toEqual([]);
  });
});

describe('extractFindings', () => {
  it('returns exact excerpts with provisional categories, statuses, and locations', () => {
    const report = [
      'Report date: 2026-03-14',
      'The patient reports intermittent left knee pain.',
      'An X-ray of the left knee was requested; results are pending.',
      'Management plan: rest and arrange follow-up in two weeks.'
    ].join('\n');
    const findings = extractFindings(report, parts, 'sample');
    expect(findings.every(finding => finding.decision === 'pending')).toBe(true);

    expect(findings.map(({ category, statusId, excerpt, location }) => ({ category, statusId, excerpt, location }))).toEqual([
      {
        category: 'symptom',
        statusId: 'documented-problem',
        excerpt: 'The patient reports intermittent left knee pain.',
        location: { type: 'region', id: 'knee', side: 'left', label: 'Left knee' }
      },
      {
        category: 'investigation',
        statusId: 'investigating',
        excerpt: 'An X-ray of the left knee was requested;',
        location: { type: 'region', id: 'knee', side: 'left', label: 'Left knee' }
      },
      {
        category: 'management',
        statusId: 'management-progress',
        excerpt: 'Management plan: rest and arrange follow-up in two weeks.',
        location: null
      }
    ]);
  });

  it('does not classify a negated symptom as a documented problem', () => {
    expect(extractFindings('The patient denies left femur pain.', parts)).toEqual([]);
  });
});