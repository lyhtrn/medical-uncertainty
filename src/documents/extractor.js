export const SUPPORTED_EXTENSIONS = ['.txt', '.md'];

export const FINDING_CATEGORIES = [
  { id: 'symptom', label: 'Symptom', statusId: 'documented-problem' },
  { id: 'investigation', label: 'Investigation', statusId: 'investigating' },
  { id: 'management', label: 'Management', statusId: 'management-progress' }
];

export const BODY_REGIONS = [
  { id: 'head', label: 'Head', terms: ['head', 'skull'] },
  { id: 'neck', label: 'Neck', terms: ['neck', 'cervical region'] },
  { id: 'chest', label: 'Chest', terms: ['chest', 'thorax', 'thoracic region'] },
  { id: 'abdomen', label: 'Abdomen', terms: ['abdomen', 'abdominal region', 'stomach area'] },
  { id: 'pelvis', label: 'Pelvis', terms: ['pelvis', 'pelvic region'] },
  { id: 'shoulder', label: 'Shoulder', terms: ['shoulder'] },
  { id: 'upper-arm', label: 'Upper arm', terms: ['upper arm', 'upper-arm'] },
  { id: 'elbow', label: 'Elbow', terms: ['elbow'] },
  { id: 'forearm', label: 'Forearm', terms: ['forearm'] },
  { id: 'wrist', label: 'Wrist', terms: ['wrist'] },
  { id: 'hand', label: 'Hand', terms: ['hand'] },
  { id: 'hip', label: 'Hip', terms: ['hip'] },
  { id: 'thigh', label: 'Thigh', terms: ['thigh'] },
  { id: 'knee', label: 'Knee', terms: ['knee', 'knees'] },
  { id: 'lower-leg', label: 'Lower leg', terms: ['lower leg', 'shin', 'calf'] },
  { id: 'ankle', label: 'Ankle', terms: ['ankle'] },
  { id: 'foot', label: 'Foot', terms: ['foot', 'feet'] },
  { id: 'back', label: 'Back', terms: ['back', 'spine'] }
];

const CATEGORY_PATTERNS = {
  symptom: /\b(pain|ache|aching|sore|swelling|swollen|numbness|tingling|weakness|fever|cough|shortness of breath|breathlessness|dizziness|rash|bleeding)\b/i,
  investigation: /\b(mri|ct scan|computed tomography|x[- ]?ray|radiograph|ultrasound|scan|imaging|blood test|laboratory test|biopsy|ecg|ekg|test requested|test ordered|investigat(?:e|ion|ing))\b/i,
  management: /\b(management|treatment|prescribed?|started on|continue|stop(?:ped)?|medication|physiotherapy|physical therapy|rest|ice pack|cold pack|follow[- ]?up|monitor(?:ing)?|review in|plan is)\b/i
};

const REGION_WORDS = new Set(BODY_REGIONS.flatMap(region => region.terms.map(normalise)));

export function isSupportedDocumentName(name) {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(extension);
}

export function normalise(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseReportDate(text) {
  const match = String(text).match(/^\s*(?:report\s+date|visit\s+date|date)\s*:\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\s*$/im);
  if (!match) return '';

  const value = match[1];
  if (/^\d{4}-/.test(value)) return value;

  const [first, second, year] = value.split(/[/-]/);
  const month = Number(first) > 12 ? second : first;
  const day = Number(first) > 12 ? first : second;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function resolveAnatomicalMention(text, partsData = {}) {
  const normalizedText = ` ${normalise(text)} `;
  const candidates = new Map();
  const explicitPartId = Object.keys(partsData).find(partId => partId.toLowerCase() === String(text).trim().toLowerCase());
  if (explicitPartId) {
    const info = partsData[explicitPartId];
    const side = info.side || (explicitPartId.endsWith('.l') ? 'left' : explicitPartId.endsWith('.r') ? 'right' : null);
    return {
      type: 'structure',
      label: info.name?.en || `${info.baseName || explicitPartId.replace(/\.[lr]$/, '')}${side ? ` (${side})` : ''}`,
      partIds: [explicitPartId]
    };
  }

  Object.entries(partsData).forEach(([partId, info]) => {
    const baseName = info.baseName || partId.replace(/\.[lr]$/, '');
    const normalizedName = normalise(baseName.replace(/^\((.*)\)$/, '$1'));
    if (!normalizedName || REGION_WORDS.has(normalizedName)) return;

    const aliases = [normalizedName, normalise(info.latinName)].filter(term => term.length >= 3);
    if (!aliases.some(term => normalizedText.includes(` ${term} `))) return;

    const group = candidates.get(normalizedName) || {
      baseName,
      parts: [],
      aliases: new Set(),
      length: normalizedName.length
    };
    aliases.forEach(alias => group.aliases.add(alias));
    group.parts.push({ partId, side: info.side || (partId.endsWith('.l') ? 'left' : partId.endsWith('.r') ? 'right' : null) });
    candidates.set(normalizedName, group);
  });

  const structures = [...candidates.values()].sort((a, b) => b.length - a.length);
  if (structures.length > 1) {
    const candidatePartIds = structures.flatMap(structure => {
      const { side, ambiguous } = sideNearMention(text, structure.aliases);
      return structure.parts
        .filter(part => ambiguous || !side || !part.side || part.side === side)
        .map(part => part.partId);
    });
    return {
      type: 'structure',
      label: 'Multiple structures mentioned',
      partIds: [],
      ambiguous: true,
      candidatePartIds: [...new Set(candidatePartIds)]
    };
  }

  const structure = structures[0];
  if (structure) {
    const { side, ambiguous: ambiguousSide } = sideNearMention(text, structure.aliases);
    const matchingParts = structure.parts.filter(part => !side || !part.side || part.side === side);
    const ambiguous = ambiguousSide || matchingParts.length !== 1;
    return {
      type: 'structure',
      label: `${structure.baseName}${side ? ` (${side})` : ambiguous ? ' (side not specified)' : ''}`,
      partIds: ambiguous ? [] : matchingParts.map(part => part.partId),
      ...(ambiguous ? {
        ambiguous: true,
        candidatePartIds: matchingParts.map(part => part.partId)
      } : {})
    };
  }

  const regionTerms = BODY_REGIONS
    .flatMap(item => item.terms.map(term => ({ item, term: normalise(term) })))
    .filter(({ term }) => term && normalizedText.includes(` ${term} `));
  const region = regionTerms
    .sort((a, b) => b.term.length - a.term.length)[0]?.item;

  if (!region) return null;
  const { side } = sideNearMention(text, regionTerms.filter(item => item.item === region).map(item => item.term));
  return {
    type: 'region',
    id: region.id,
    side,
    label: side ? `${side[0].toUpperCase()}${side.slice(1)} ${region.label.toLowerCase()}` : region.label
  };
}

function sideNearMention(text, terms) {
  const normalizedText = normalise(text);
  const paddedText = ` ${normalizedText} `;
  const positions = new Map();
  terms.forEach(term => {
    let start = 0;
    while (true) {
      const position = paddedText.indexOf(` ${term} `, start);
      if (position === -1) break;
      positions.set(position, term.length);
      start = position + term.length + 2;
    }
  });

  const allowedBetweenSideAndStructure = new Set([
    'anterior', 'distal', 'in', 'lateral', 'lower', 'medial', 'of', 'on',
    'posterior', 'proximal', 'side', 'the', 'upper'
  ]);
  const sides = new Set();
  let hasUnresolvedMention = false;

  for (const [paddedPosition, termLength] of positions) {
    const position = paddedPosition;
    const precedingWords = normalizedText.slice(0, position).trim().split(/\s+/u).slice(-5);
    if (/\b(?:left\s+(?:and\s+)?right|right\s+(?:and\s+)?left)\s*$/u.test(precedingWords.join(' '))) {
      return { side: null, ambiguous: true };
    }

    const nearbySides = precedingWords.filter((word, index) => {
      if (word !== 'left' && word !== 'right') return false;
      return precedingWords.slice(index + 1).every(next => allowedBetweenSideAndStructure.has(next));
    });
    const sideAfter = normalizedText.slice(position + termLength).trim().split(/\s+/u).slice(0, 2);
    const trailingSide = sideAfter[0] === 'on' && (sideAfter[1] === 'left' || sideAfter[1] === 'right')
      ? sideAfter[1]
      : null;
    const mentionSides = new Set([...nearbySides, ...(trailingSide ? [trailingSide] : [])]);

    if (mentionSides.size > 1) return { side: null, ambiguous: true };
    if (mentionSides.size === 1) sides.add(mentionSides.values().next().value);
    else hasUnresolvedMention = true;
  }

  if (sides.size > 1 || (sides.size && hasUnresolvedMention)) return { side: null, ambiguous: true };
  return { side: sides.values().next().value || null, ambiguous: false };
}

export function extractFindings(text, partsData = {}, documentId = 'document') {
  const excerpts = String(text)
    .split(/(?<=[.!?;])\s+|\r?\n+/u)
    .map(excerpt => excerpt.trim())
    .filter(Boolean);
  const findings = [];

  excerpts.forEach(excerpt => {
    FINDING_CATEGORIES.forEach(category => {
      if (!CATEGORY_PATTERNS[category.id].test(excerpt) || isNegatedFinding(excerpt, category.id)) return;

      findings.push({
        id: `${documentId}:${findings.length}`,
        category: category.id,
        excerpt,
        location: resolveAnatomicalMention(excerpt, partsData),
        statusId: category.statusId,
        decision: 'pending',
        confirmedAt: null
      });
    });
  });

  return findings;
}

function isNegatedFinding(excerpt, categoryId) {
  const pattern = new RegExp(CATEGORY_PATTERNS[categoryId].source, 'gi');
  for (const match of excerpt.matchAll(pattern)) {
    const precedingText = excerpt.slice(0, match.index);
    if (/(?:\bno\b|\bnot\b|\bdenies\b|\bwithout\b|\bnegative\s+for\b|\bruled\s+out\b)(?:\W+\w+){0,3}\s*$/i.test(precedingText)) {
      continue;
    }
    return false;
  }
  return true;
}