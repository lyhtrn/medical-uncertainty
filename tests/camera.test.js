import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getRegionBounds } from '../src/viewer/regionBounds.js';

function boxAt(x, y, z, width = 0.1, height = 0.1, depth = 0.1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y, z);
  return mesh;
}

describe('body-region camera bounds', () => {
  it('uses the real mesh bounds to isolate the requested anatomical region', () => {
    const head = boxAt(0, 1.45, 0);
    const torso = boxAt(0, 0.9, 0, 0.4, 0.4, 0.2);
    const foot = boxAt(0, 0.1, 0);

    const bounds = getRegionBounds([head, torso, foot], 'head-neck');

    expect(bounds.min.y).toBeGreaterThan(1.3);
    expect(bounds.max.y).toBeLessThan(1.6);
  });

  it('includes lateral meshes when framing arms and hands', () => {
    const leftArm = boxAt(-0.5, 0.8, 0);
    const torso = boxAt(0, 0.8, 0, 0.5, 0.4, 0.2);
    const rightArm = boxAt(0.5, 0.8, 0);

    const bounds = getRegionBounds([leftArm, torso, rightArm], 'arms-hands');

    expect(bounds.min.x).toBeLessThan(-0.5);
    expect(bounds.max.x).toBeGreaterThan(0.5);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeGreaterThan(1);
  });
});
