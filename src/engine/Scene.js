import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import Controls from './Controls.js';

// ModelAssets is a generic static asset loader — physics lives entirely in the worker.

class TextureAssets {
  static #cache = new Map();

  static loadTexture(path) {
    if (TextureAssets.#cache.has(path)) {
      return TextureAssets.#cache.get(path);
    }

    const promise = new Promise((resolve, reject) => {
      const textureLoader = new THREE.TextureLoader();

      textureLoader.load(
        path,
        (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(50, 50);
          resolve(texture);
        },
        (xhr) => {
          if (xhr.total > 0) {
            console.log(`Texture: ${(xhr.loaded / xhr.total * 100).toFixed(0)}% loaded`);
          }
        },
        (error) => reject(error)
      );
    }).catch((error) => {
      console.error(`Texture load error (${path}):`, error);
      TextureAssets.#cache.delete(path); // Allow retrying on failure
      throw error;
    });

    TextureAssets.#cache.set(path, promise);
    return promise;
  }
}

const MODEL_OBJ_PATH = '/src/assets/Car.obj';
const MODEL_MTL_PATH = '/src/assets/Car.mtl';

// Must match MODEL_BASE_SIZE in physics.worker.js — this is the `r` value at which
// the model's hitbox is exactly MODEL_BASE_HALF_EXTENTS, i.e. "no scaling applied".
const MODEL_BASE_SIZE = 3.0;

export class ModelAssets {
  static #cache = new Map();

  static load(objPath, mtlPath, onLoad) {
    const key = `${objPath}|${mtlPath}`;
    let loadingPromise = ModelAssets.#cache.get(key);

    if (!loadingPromise) {
      loadingPromise = new Promise((resolve, reject) => {
        const mtlLoader = new MTLLoader();
        mtlLoader.load(
          mtlPath,
          (materials) => {
            materials.preload();
            const objLoader = new OBJLoader();
            objLoader.setMaterials(materials);
            objLoader.load(
              objPath,
              (object) => resolve(object),
              (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% loaded'),
              (error) => reject(error)
            );
          },
          undefined,
          (error) => reject(error)
        );
      }).catch((error) => {
        console.error(`Model asset load error (${key}):`, error);
        ModelAssets.#cache.delete(key); // allow retrying on failure
        throw error;
      });

      ModelAssets.#cache.set(key, loadingPromise);
    }

    loadingPromise.then((template) => onLoad(template.clone()))
      .catch(() => {}); // already logged above
  }
}


class Scene {
  #initialized = false;
  scene = null;
  camera = null;
  worker = null;
  instancedMesh = null;
  dummy = new THREE.Object3D();
  maxCount = 10000;
  baseRadius = 3.0;
  STRIDE = 10;
  JOINTSTRIDE = 5;
  modelMeshes = new Map();
  followTarget = null; // any THREE.Object3D the camera should follow — see setCameraFollowTarget()
  pendingModelRequests = new Map();
  pendingBallRequests = new Map();
  pendingJointRequests = new Map();
  pendingObjectResolvers = new Map(); // objectId -> resolve (models, awaiting mesh load)
  ballProxies = new Map();            // objectId -> Object3D (position/quat mirror)
  jointLines = new Map();             // "idA_idB" -> THREE.Line
  nextRequestId = 0;

  async createScene() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 50, 100);
    this.camera.lookAt(0, 0, 0);
    

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const light = new THREE.PointLight(0xffffff, 50, 100);
    light.position.set(5, 10, 5);
    this.scene.add(light);

    const groundTexture = await TextureAssets.loadTexture('/src/assets/missing.png');

    const groundMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1000, 0.2, 1000),
      new THREE.MeshStandardMaterial({ 
        map: groundTexture,
            roughness: 0
      })
    );
    groundMesh.position.set(0, -3, 0);
    this.scene.add(groundMesh);

    const geometry = new THREE.SphereGeometry(this.baseRadius, 12, 12);
    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.2 });
    this.instancedMesh = new THREE.InstancedMesh(geometry, material, this.maxCount);
    this.instancedMesh.count = 0;
    this.instancedMesh.frustumCulled = false;
    this.scene.add(this.instancedMesh);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.worker = new Worker(new URL('./physics.worker.js', import.meta.url), { type: 'module' });
     Controls.setWorker(this.worker);
    this.worker.postMessage({ type: 'INIT' });
   

    this.worker.onmessage = (e) => {
      const { type, objectBuffer, jointBuffer, requestId, id } = e.data;

      if (type === 'TICK') {
        this.updateMeshFromBuffer(objectBuffer, jointBuffer);
      }

      if (type === 'OBJECT_ID') {
        if (this.pendingModelRequests.has(requestId)) {
          const resolve = this.pendingModelRequests.get(requestId);
          this.pendingModelRequests.delete(requestId);
          const entry = this.modelMeshes.get(id);
          if (entry && entry.mesh) resolve(entry.mesh);
          else this.pendingObjectResolvers.set(id, resolve);
        }

        if (this.pendingBallRequests.has(requestId)) {
          const resolve = this.pendingBallRequests.get(requestId);
          this.pendingBallRequests.delete(requestId);
          const proxy = new THREE.Object3D(); // not added to scene — instancedMesh already draws it
          proxy.userData.physicsId = id; // lets createJoint() accept this object directly
          this.ballProxies.set(id, proxy);
          resolve(proxy); // transform fills in on the next tick
        }
      }

      if (type === 'JOINT_ID') {
        if (this.pendingJointRequests.has(requestId)) {
          const resolve = this.pendingJointRequests.get(requestId);
          this.pendingJointRequests.delete(requestId);
          resolve(id); // may be null if the worker couldn't find the two bodies
        }
      }
    };

    

    const animate = () => {
      requestAnimationFrame(animate);

      Controls.sendRepelUpdate(this.camera, 5.0, 10.0);
      this.updateCamera();

      renderer.render(this.scene, this.camera);
    };
    animate();
  }

  setCameraFollowTarget(object) {
    this.followTarget = object ?? null;
  }

  updateCamera() {
    if (!this.followTarget) return; // nothing to follow — leave camera as-is

    const target = this.followTarget;

    const localOffset = new THREE.Vector3(0, 6, -12); // (x, height, distance-behind)
    const desiredPos = localOffset.clone()
      .applyQuaternion(target.quaternion)
      .add(target.position);

    const followLerp = 0.1;
    this.camera.position.lerp(desiredPos, followLerp);

    const lookTarget = target.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    this.camera.lookAt(lookTarget);
  }

  updateMeshFromBuffer(objectBuffer, jointBuffer) {
  const STRIDE = this.STRIDE;
  const count = objectBuffer.length / STRIDE;

  let ballIndex = 0;
  const seenModelIds = new Set();
  const seenBallIds = new Set();

  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const x = objectBuffer[o], y = objectBuffer[o + 1], z = objectBuffer[o + 2];
    const qx = objectBuffer[o + 3], qy = objectBuffer[o + 4], qz = objectBuffer[o + 5], qw = objectBuffer[o + 6];
    const r = objectBuffer[o + 7];
    const id = objectBuffer[o + 8];
    const typeCode = objectBuffer[o + 9];
    const isModel = typeCode === 1;

    if (isModel) {
      seenModelIds.add(id);
      let entry = this.modelMeshes.get(id);

      if (!entry) {
        entry = { mesh: null };
        this.modelMeshes.set(id, entry);
        ModelAssets.load(MODEL_OBJ_PATH, MODEL_MTL_PATH, (object) => {
          entry.mesh = object;
          object.userData.physicsId = id; // lets createJoint() accept this object directly
          object.scale.setScalar(r / MODEL_BASE_SIZE);
          this.scene.add(object);

          const resolve = this.pendingObjectResolvers.get(id);
          if (resolve) {
            this.pendingObjectResolvers.delete(id);
            resolve(object);
          }
        });
      }

      if (entry.mesh) {
        entry.mesh.position.set(x, y, z);
        entry.mesh.quaternion.set(qx, qy, qz, qw);
      }
    } else {
      seenBallIds.add(id);

      this.dummy.position.set(x, y, z);
      this.dummy.quaternion.set(qx, qy, qz, qw);
      this.dummy.scale.setScalar(r / this.baseRadius);
      this.dummy.updateMatrix();
      this.instancedMesh.setMatrixAt(ballIndex, this.dummy.matrix);
      ballIndex++;

      const proxy = this.ballProxies.get(id);
      if (proxy) {
        proxy.position.set(x, y, z);
        proxy.quaternion.set(qx, qy, qz, qw);
      }
    }
  }

  this.instancedMesh.count = ballIndex;
  this.instancedMesh.instanceMatrix.needsUpdate = true;

  for (const [id, entry] of this.modelMeshes) {
    if (!seenModelIds.has(id)) {
      if (entry.mesh) {
        this.scene.remove(entry.mesh);
        entry.mesh.traverse((child) => {
          if (child.isMesh) {
            child.geometry.dispose();
            (Array.isArray(child.material) ? child.material : [child.material])
              .forEach((m) => m.dispose());
          }
        });
      }
      this.modelMeshes.delete(id);
      if (entry.mesh === this.followTarget) this.followTarget = null;
    }
  }

  for (const [id, proxy] of this.ballProxies) {
    if (!seenBallIds.has(id)) {
      this.ballProxies.delete(id);
      if (proxy === this.followTarget) this.followTarget = null;
    }
  }

  this.updateJointLines(jointBuffer);
}

  getObjectPosition(id) {
    const modelEntry = this.modelMeshes.get(id);
    if (modelEntry && modelEntry.mesh) return modelEntry.mesh.position;

    const proxy = this.ballProxies.get(id);
    if (proxy) return proxy.position;

    return null;
  }

  updateJointLines(jointBuffer) {
    if (!jointBuffer) return;

    const STRIDE = this.JOINTSTRIDE;
    const count = jointBuffer.length / STRIDE;
    const seenKeys = new Set();

    for (let i = 0; i < count; i++) {
      const o = i * STRIDE;
      const idA = jointBuffer[o];
      const idB = jointBuffer[o + 1];
      const key = `${idA}_${idB}`;

      const posA = this.getObjectPosition(idA);
      const posB = this.getObjectPosition(idB);
      if (!posA || !posB) continue; // meshes haven't loaded yet (e.g. a model still fetching)

      seenKeys.add(key);

      let line = this.jointLines.get(key);
      if (!line) {
        const geometry = new THREE.BufferGeometry().setFromPoints([posA, posB]);
        const material = new THREE.LineBasicMaterial({ color: 0xffaa00 });
        line = new THREE.Line(geometry, material);
        this.scene.add(line);
        this.jointLines.set(key, line);
      } else {
        const positions = line.geometry.attributes.position;
        positions.setXYZ(0, posA.x, posA.y, posA.z);
        positions.setXYZ(1, posB.x, posB.y, posB.z);
        positions.needsUpdate = true;
      }
    }

    for (const [key, line] of this.jointLines) {
      if (!seenKeys.has(key)) {
        this.scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        this.jointLines.delete(key);
      }
    }
  }
  
  createBall(x = 0, y = 5, z = 0, r = 3.0) {
    if (!this.worker) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingBallRequests.set(requestId, resolve);
      this.worker.postMessage({ type: 'CREATE_BALL', payload: { x, y, z, r, requestId } });
    });
  }

  createModel(x = 0, y = 5, z = 0, r = 3.0) {
    if (!this.worker) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingModelRequests.set(requestId, resolve);
      this.worker.postMessage({ type: 'CREATE_MODEL', payload: { x, y, z, r, requestId } });
    });
  }

  createJoint(objA, objB, restLength = 3, stiffness = 3, damping = 3) {
    if (!this.worker) return Promise.resolve(null);

    const idA = typeof objA === 'number' ? objA : objA?.userData?.physicsId;
    const idB = typeof objB === 'number' ? objB : objB?.userData?.physicsId;

    if (idA == null || idB == null) {
      console.warn('createJoint: could not resolve a physics id for one or both objects', objA, objB);
      return Promise.resolve(null);
    }

    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingJointRequests.set(requestId, resolve);
      this.worker.postMessage({ type: 'CREATE_JOINT', payload: { idA, idB, restLength, stiffness, damping, requestId } });
    });
  }
}

export default new Scene();