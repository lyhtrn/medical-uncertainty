import * as THREE from 'three';

const REGION_RANGES = {
  'head-neck': { y: [0.72, 1], x: 'center' },
  'chest-abdomen': { y: [0.43, 0.79], x: 'center' },
  'arms-hands': { y: [0.24, 0.83], x: 'sides' },
  'hips-pelvis': { y: [0.29, 0.55], x: 'center' },
  'legs-feet': { y: [0, 0.44], x: 'all' }
};

export function getRegionBounds(meshes, regionId) {
  const meshBounds = meshes
    .map(mesh => new THREE.Box3().setFromObject(mesh))
    .filter(box => !box.isEmpty());
  if (!meshBounds.length) return null;

  const body = meshBounds.reduce((bounds, box) => bounds.union(box), new THREE.Box3());
  const bodySize = body.getSize(new THREE.Vector3());
  const bodyCenter = body.getCenter(new THREE.Vector3());
  const range = REGION_RANGES[regionId];
  if (!range) return body;

  const selected = meshBounds.filter(box => {
    const center = box.getCenter(new THREE.Vector3());
    const height = bodySize.y ? (center.y - body.min.y) / bodySize.y : 0.5;
    if (height < range.y[0] || height > range.y[1]) return false;

    const horizontalOffset = Math.abs(center.x - bodyCenter.x);
    if (range.x === 'center') return horizontalOffset <= bodySize.x * 0.34;
    if (range.x === 'sides') return horizontalOffset >= bodySize.x * 0.14;
    return true;
  });

  return selected.reduce((bounds, box) => bounds.union(box), new THREE.Box3());
}
