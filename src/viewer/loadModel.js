// Model Loading - GLB loading, mesh registry, material handling
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { state, setLoadingSystem, getMedicalStatus } from '../state/store.js';
import { asset } from '../utils/paths.js';
import { medicalStatusColor } from './medicalColor.js';

// Without an acceleration structure, picking cost grows with the triangle
// count: 10.4M triangles tested per pointer event across seven systems.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// The Z-Anatomy models are exported with Draco compression, so the decoder
// (copied into public/draco) is required to read them.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(asset('draco/'));
// Fetch the decoder alongside the first model instead of after it: otherwise
// the two requests are serialised on the critical path.
dracoLoader.preload();

let meshRegistry = new Map(); // Map<partId, node>
let structures = new Map(); // Map<partId, { node, systemId, parentId, childIds, ownMeshes }>
let systemRegistry = new Map(); // Map<systemId, node[]>
let modelRoots = new Map(); // Map<systemId, gltf.scene>
let loadingManager = new THREE.LoadingManager();
const statusMaterialVariants = new WeakMap();

export function getMeshRegistry() {
  return meshRegistry;
}

export function getSystemRegistry() {
  return systemRegistry;
}

export function getStructure(partId) {
  return structures.get(partId);
}

// Roots of the loaded models. Raycasting against these instead of against the
// registry avoids re-testing shared subtrees once per nested structure.
export function getPickTargets() {
  return Array.from(modelRoots.values());
}

// The meshes a structure owns directly, i.e. excluding those belonging to a
// nested structure. 868 of the 2827 structures are descendants of another one,
// so "every mesh under this node" is not the same thing as "this structure".
export function ownMeshesOf(partId) {
  const entry = structures.get(partId);
  return entry ? entry.ownMeshes : [];
}

// A structure plus everything nested inside it, in document order.
export function withDescendants(partId) {
  const out = [];
  const walk = id => {
    const entry = structures.get(id);
    if (!entry) return;
    out.push(id);
    entry.childIds.forEach(walk);
  };
  walk(partId);
  return out;
}

export function getLoadedSystems() {
  return state.loadedSystems;
}

const inFlight = new Map();

// One model per system, however many callers ask for it. Two of them can ask
// at once — a shared link restoring its state while the opening batch is still
// in flight — and a second scene.add() would leave an unreachable copy of the
// whole system behind: rendered, counted twice in loadedSystems, and written
// twice into the link the next time it is serialised.
export function loadModel(systemId, viewer, options = {}) {
  if (state.loadedSystems.includes(systemId)) {
    return Promise.resolve({
      systemId,
      model: modelRoots.get(systemId),
      meshCount: systemRegistry.get(systemId)?.length || 0
    });
  }

  const running = inFlight.get(systemId);
  if (running) return running;

  const promise = loadModelOnce(systemId, viewer, options).finally(() => inFlight.delete(systemId));
  inFlight.set(systemId, promise);
  return promise;
}

async function loadModelOnce(systemId, viewer, options = {}) {
  const { scene, renderer, camera } = viewer;

  console.log(`[loadModel] Starting load of ${systemId}.glb`);

  const gltf = await new Promise((resolve, reject) => {
    const loader = new GLTFLoader(loadingManager);
    loader.setDRACOLoader(dracoLoader);
    const modelPath = asset(`models/${systemId}.glb`);

    setLoadingSystem(systemId, false, 0);

    loader.load(
      modelPath,
      resolve,
      (xhr) => {
        // Bytes are reported even when the server sends no content-length, so
        // the UI can show something either way.
        setLoadingSystem(systemId, false, xhr.lengthComputable ? (xhr.loaded / xhr.total) * 100 : 0, {
          loaded: xhr.loaded,
          total: xhr.lengthComputable ? xhr.total : 0
        });
      },
      (error) => {
        console.error(`[loadModel] Error loading ${systemId}:`, error);
        setLoadingSystem(systemId, true, 100, { failed: true });
        reject(error);
      }
    );
  });

  const model = gltf.scene;
  processModel(model, systemId, viewer);

  // Compiling before the model joins the scene keeps the first frame after a
  // load from stalling on shader and buffer upload.
  if (renderer?.compileAsync) {
    try {
      await renderer.compileAsync(model, camera, scene);
    } catch {
      // Compilation is an optimisation; a failure must not block the load.
    }
  }

  scene.add(model);
  modelRoots.set(systemId, model);

  state.loadedSystems.push(systemId);
  setLoadingSystem(systemId, true, 100);

  return { systemId, model, meshCount: systemRegistry.get(systemId)?.length || 0 };
}

function processModel(model, systemId, viewer) {
  const nodes = [];

  // The glTF carries the untouched Z-Anatomy name in `za_name`, because the
  // exporter rewrites object names (spaces, dots) and paired structures would
  // otherwise collapse onto the same name.
  model.traverse((child) => {
    const partId = child.userData?.za_name;
    if (!partId) return;

    child.userData.partId = partId;
    child.userData.system = systemId;
    child.userData.originalName = partId;

    // The glTF graph is nested: a structure can be the parent of another one.
    // Record that relation instead of flattening it, because three.js applies
    // `visible` down the whole subtree and hiding a parent would take its
    // children with it.
    const parentId = findAncestorPartId(child.parent);

    nodes.push(child);
    meshRegistry.set(partId, child);
    structures.set(partId, {
      node: child,
      systemId,
      parentId,
      childIds: [],
      ownMeshes: []
    });

    if (parentId) {
      const parent = structures.get(parentId);
      if (parent) parent.childIds.push(partId);
    }
  });

  // A nested structure is often a child of a node that is itself a mesh, so
  // hiding the parent would hide the child with it. Detach every nested
  // structure to the model root (attach preserves the world transform): the
  // anatomical nesting stays recorded above, but visibility becomes
  // independent per structure.
  model.updateMatrixWorld(true);
  nodes.forEach(node => {
    if (structures.get(node.userData.partId).parentId) {
      model.attach(node);
    }
  });

  // Assign every mesh to the closest structure above it, so a parent structure
  // never claims the geometry of a nested one.
  model.traverse((child) => {
    if (!child.isMesh) return;

    setupMesh(child, systemId, viewer);

    const ownerId = findAncestorPartId(child);
    const owner = ownerId && structures.get(ownerId);
    if (owner) owner.ownMeshes.push(child);

    const statusId = getMedicalStatus(ownerId);
    child.material = Array.isArray(child.material)
      ? child.material.map(material => statusMaterialVariant(material, statusId))
      : statusMaterialVariant(child.material, statusId);
  });

  systemRegistry.set(systemId, nodes);
  console.log(`Loaded ${systemId}: ${nodes.length} structures`);
}

function statusMaterialVariant(baseMaterial, statusId) {
  if (!baseMaterial) return baseMaterial;
  let variants = statusMaterialVariants.get(baseMaterial);
  if (!variants) {
    variants = new Map();
    statusMaterialVariants.set(baseMaterial, variants);
  }

  const key = statusId || 'no-concern';
  if (!variants.has(key)) {
    const material = baseMaterial.clone();
    material.color?.set(medicalStatusColor(statusId));
    variants.set(key, material);
  }
  return variants.get(key);
}

// Walks up from `node` (inclusive) to the closest node carrying a partId.
function findAncestorPartId(node) {
  let current = node;
  while (current) {
    if (current.userData?.partId) return current.userData.partId;
    current = current.parent;
  }
  return null;
}

function setupMesh(mesh, systemId, viewer) {
  // Idempotent: a mesh must not be set up twice.
  if (mesh.userData.baseMaterial) return;

  // The GLB ships 65 materials shared across thousands of meshes. Cloning one
  // per mesh used to produce 3499 distinct materials, which defeats three.js
  // render-state sorting. Keep the shared reference and clone only when a mesh
  // is actually modified — see viewer/visibility.js.
  if (mesh.material) {
    mesh.userData.baseMaterial = mesh.material;
  }

  if (mesh.geometry && !mesh.geometry.boundsTree) {
    mesh.geometry.computeBoundsTree();
  }

  // Enable shadows if needed (disabled for performance in v1)
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // Frustum culling
  mesh.frustumCulled = true;

  // Set render order for transparent objects
  if (mesh.material && (Array.isArray(mesh.material) ? mesh.material.some(m => m.transparent) : mesh.material.transparent)) {
    mesh.renderOrder = 1;
  }
}

export async function loadSystems(systemIds, viewer, options = {}) {
  const { sequential = false } = options;

  if (sequential) {
    for (const systemId of systemIds) {
      try {
        await loadModel(systemId, viewer);
      } catch (error) {
        console.error(`Failed to load ${systemId}:`, error);
      }
    }
  } else {
    // Parallel loading with a concurrency limit: one worker per slot, each
    // taking the next system off the queue until it runs dry. The queue used
    // to be driven from two places at once — the .finally of every load and a
    // Promise.race chain whose result was discarded — which oversubscribed the
    // limit and, from six systems up, returned while the last ones were still
    // loading. Whoever awaited it then restored a shared link against a scene
    // that was not finished.
    const concurrency = 2;
    const queue = [...systemIds];

    const worker = async () => {
      while (queue.length) {
        const systemId = queue.shift();
        try {
          await loadModel(systemId, viewer);
        } catch (error) {
          // A model that will not load costs its own system and nothing else,
          // exactly as in the sequential branch above.
          console.error(`Failed to load ${systemId}:`, error);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  // Center camera on all loaded models
  centerCamera(viewer);

  return meshRegistry;
}

function centerCamera(viewer) {
  const { scene, camera, controls } = viewer;

  const box = new THREE.Box3();
  let hasGeometry = false;

  scene.traverse(child => {
    if (child.isMesh && child.visible) {
      box.expandByObject(child);
      hasGeometry = true;
    }
  });

  if (!hasGeometry || box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // Position camera
  const distance = maxDim * 1.5;
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  controls.target.copy(center);
  controls.update();

  // Store initial camera state for reset
  camera.userData.initialPosition = camera.position.clone();
  camera.userData.initialTarget = controls.target.clone();
  camera.userData.initialZoom = controls.zoom;
}

export function getMeshesBySystem(systemId) {
  return systemRegistry.get(systemId) || [];
}

// Walks the structures rather than the nodes, so meshes shared with a nested
// structure are not counted twice.
export function getAllMeshes() {
  return Array.from(structures.values()).flatMap(entry => entry.ownMeshes);
}

// Frees a system's GPU buffers. Without this, memory only ever grows: seven
// systems is roughly 187 MB that a mobile tab never gets back.
export function unloadSystem(systemId) {
  const model = modelRoots.get(systemId);
  if (!model) return false;

  model.removeFromParent();

  const seenMaterials = new Set();
  model.traverse(object => {
    if (!object.isMesh) return;

    object.geometry?.disposeBoundsTree?.();
    object.geometry?.dispose();

    const materials = [object.material, object.userData.baseMaterial]
      .flatMap(entry => (Array.isArray(entry) ? entry : [entry]))
      .filter(Boolean);

    materials.forEach(material => {
      if (seenMaterials.has(material)) return;
      seenMaterials.add(material);
      material.dispose();
    });
  });

  structures.forEach((entry, partId) => {
    if (entry.systemId !== systemId) return;
    structures.delete(partId);
    meshRegistry.delete(partId);
    state.partStates.delete(partId);
  });

  systemRegistry.delete(systemId);
  modelRoots.delete(systemId);
  state.loadedSystems = state.loadedSystems.filter(id => id !== systemId);

  return true;
}

// Visibility, transparency and highlighting all live in viewer/visibility.js,
// which is the single owner of material state.

export function getModelStats() {
  let totalMeshes = 0;
  let totalTriangles = 0;

  getAllMeshes().forEach(mesh => {
    totalMeshes++;
    if (mesh.geometry && mesh.geometry.index) {
      totalTriangles += mesh.geometry.index.count / 3;
    } else if (mesh.geometry && mesh.geometry.attributes.position) {
      totalTriangles += mesh.geometry.attributes.position.count / 3;
    }
  });

  return { totalMeshes, totalTriangles };
}

// Cleanup
export function dispose() {
  getAllMeshes().forEach(mesh => {
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(mat => mat.dispose());
    }
  });
  meshRegistry.clear();
  structures.clear();
  systemRegistry.clear();
  modelRoots.clear();
  state.loadedSystems = [];
}