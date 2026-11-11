import { describe, it, expect } from 'vitest';
import { splitSide, formatPartName, buildPartsData, SYSTEM_IDS, ANATOMY_LAYERS, BODY_REGIONS } from '../src/data/anatomy.js';

describe('splitSide', () => {
  it('separates the Z-Anatomy side suffix', () => {
    expect(splitSide('Femur.l')).toEqual({ base: 'Femur', side: 'left' });
    expect(splitSide('Femur.r')).toEqual({ base: 'Femur', side: 'right' });
  });

  it('leaves unpaired structures alone', () => {
    expect(splitSide('Body of sternum')).toEqual({ base: 'Body of sternum', side: null });
  });

  it('does not mistake a trailing letter for a side', () => {
    expect(splitSide('Vertebra L5')).toEqual({ base: 'Vertebra L5', side: null });
  });
});

describe('formatPartName', () => {
  it('localises the side', () => {
    expect(formatPartName('Femur.l', 'en')).toBe('Femur (left)');
    expect(formatPartName('Femur.l', 'it')).toBe('Femur (sinistro)');
  });

  it('strips the parentheses Z-Anatomy uses for non-official terms', () => {
    expect(formatPartName('(Adductor minimus).r', 'en')).toBe('Adductor minimus (right)');
  });

  it('keeps inner parentheses, which are part of the name', () => {
    expect(formatPartName('Atlas (C1)', 'en')).toBe('Atlas (C1)');
    expect(formatPartName('Abducens nerve (VI).l', 'en')).toBe('Abducens nerve (VI) (left)');
  });
});

describe('buildPartsData', () => {
  const systems = {
    skeletal: ['Femur.l', 'Femur.r', 'Body of sternum'],
    muscular: ['(Adductor minimus).l']
  };

  it('indexes every mesh and records its system', () => {
    const parts = buildPartsData(systems);
    expect(Object.keys(parts)).toHaveLength(4);
    expect(parts['Femur.l'].system).toBe('skeletal');
    expect(parts['Femur.l'].baseName).toBe('Femur');
    expect(parts['Femur.l'].side).toBe('left');
  });

  it('shares lexicon entries between the two sides', () => {
    const parts = buildPartsData(systems, { Femur: { la: 'Os femoris' } });
    expect(parts['Femur.l'].latinName).toBe('Os femoris');
    expect(parts['Femur.r'].latinName).toBe('Os femoris');
  });

  it('marks non-official terminology', () => {
    const parts = buildPartsData(systems, { '(Adductor minimus)': { official: false } });
    expect(parts['(Adductor minimus).l'].official).toBe(false);
    expect(parts['Femur.l'].official).toBe(true);
  });

  it('survives an empty lexicon', () => {
    const parts = buildPartsData(systems);
    expect(parts['Femur.l'].latinName).toBe('');
    expect(parts['Femur.l'].official).toBe(true);
  });
});

describe('SYSTEM_IDS', () => {
  it('matches the seven models that are exported', () => {
    expect(SYSTEM_IDS).toEqual([
      'skeletal', 'muscular', 'joints', 'cardiovascular', 'lymphatic', 'nervous', 'visceral'
    ]);
  });
});

describe('patient-friendly anatomy controls', () => {
  it('maps available layers to the exported atlas systems and marks skin unavailable', () => {
    expect(ANATOMY_LAYERS.map(layer => layer.id)).toEqual([
      'skin', 'muscles', 'skeleton', 'organs', 'nerves', 'blood-vessels', 'joints-soft-tissue'
    ]);
    expect(ANATOMY_LAYERS.find(layer => layer.id === 'skin').systems).toEqual([]);
    expect(ANATOMY_LAYERS.find(layer => layer.id === 'organs').systems).toEqual(['visceral', 'lymphatic']);
    ANATOMY_LAYERS.flatMap(layer => layer.systems).forEach(systemId => {
      expect(SYSTEM_IDS).toContain(systemId);
    });
  });

  it('offers the six supported body regions', () => {
    expect(BODY_REGIONS.map(region => region.label.en)).toEqual([
      'Full body', 'Head & neck', 'Chest & abdomen', 'Arms & hands', 'Hips & pelvis', 'Legs & feet'
    ]);
  });
});
