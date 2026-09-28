import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { MODELS, modelKeyFor, HTML_TYPE_CODE } from './modelRegistry.js';
import Controls from './Controls.js';


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

    loadingPromise.then(
      (template) => onLoad(template.clone()),
      () => {} // load failure, already logged above
    );
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
  JOINTSTRIDE = 11;
  _pA = new THREE.Vector3();
  _pB = new THREE.Vector3();
  modelMeshes = new Map(); 
  followTarget = null; // any THREE.Object3D the camera should follow — see setCameraFollowTarget()
  pendingModelRequests = new Map();
  pendingBallRequests = new Map();
  pendingJointRequests = new Map();
  pendingObjectResolvers = new Map(); // objectId -> resolve (models, awaiting mesh load)
  ballProxies = new Map();            // objectId -> Object3D (position/quat mirror)
  jointLines = new Map();             // "idA_idB" -> THREE.Line
  nextRequestId = 0;
  htmlBlocks = new Map();          // objectId -> { group, mesh, css }
  pendingHtmlRequests = new Map(); // requestId -> { resolve, spec }

  async createScene() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 50, 100);
    this.camera.lookAt(0, 0, 0);
    

   const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.pointerEvents = 'none';

    const cssRenderer = new CSS3DRenderer();
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
    cssRenderer.domElement.id = 'css3d';

    for (const el of [cssRenderer.domElement, renderer.domElement]) {
      Object.assign(el.style, { position: 'absolute', top: '0', left: '0' });
    }
    document.body.style.background = '#000';           // sky is now transparent
    document.body.appendChild(cssRenderer.domElement);  // behind
    document.body.appendChild(renderer.domElement);     // in front

    // shared materials for html blocks
    this.htmlHoleMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000, opacity: 0, blending: THREE.NoBlending, // punches a transparent hole in the canvas
    });
    this.htmlSolidMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });

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
      cssRenderer.setSize(window.innerWidth, window.innerHeight);
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

        if (this.pendingHtmlRequests.has(requestId)) {
          const { resolve, spec } = this.pendingHtmlRequests.get(requestId);
          this.pendingHtmlRequests.delete(requestId);

          const block = this.buildHtmlBlock(spec);
          block.group.position.set(spec.x, spec.y, spec.z);
          block.group.userData.physicsId = id;   // createJoint() accepts this directly
          this.scene.add(block.group);
          this.htmlBlocks.set(id, block);
          resolve(block.group);
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

      Controls.sendGrabUpdate(this.camera);

      this.updateCamera();

      renderer.render(this.scene, this.camera);
      cssRenderer.render(this.scene, this.camera);
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
    const seenHtmlIds = new Set();

  
  

    for (let i = 0; i < count; i++) {
      const o = i * STRIDE;
      const x = objectBuffer[o], y = objectBuffer[o + 1], z = objectBuffer[o + 2];
      const qx = objectBuffer[o + 3], qy = objectBuffer[o + 4], qz = objectBuffer[o + 5], qw = objectBuffer[o + 6];
      const r = objectBuffer[o + 7];
      const id = objectBuffer[o + 8];
      const typeCode = objectBuffer[o + 9];
      const isModel = typeCode > 0;
      const isHtml = typeCode === HTML_TYPE_CODE;

      if (isHtml) {
        seenHtmlIds.add(id);
        const block = this.htmlBlocks.get(id);
        if (block) {
          block.group.position.set(x, y, z);
          block.group.quaternion.set(qx, qy, qz, qw);
        }
      } else {
        if (isModel) {
          seenModelIds.add(id);
          let entry = this.modelMeshes.get(id);

          if (!entry) {
            entry = { mesh: null };
            this.modelMeshes.set(id, entry);

            const def = MODELS[modelKeyFor(typeCode)];
            ModelAssets.load(def.obj, def.mtl, (object) => {
              entry.mesh = object;
              object.userData.physicsId = id;
              object.scale.setScalar(r / def.baseSize);
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

    for (const [id, block] of this.htmlBlocks) {
      if (!seenHtmlIds.has(id)) {
        block.css.element.remove();          // CSS3DRenderer won't detach the iframe for you here
        this.scene.remove(block.group);
        block.mesh.geometry.dispose();       // shared materials stay
        this.htmlBlocks.delete(id);
        if (block.group === this.followTarget) this.followTarget = null;
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

  getObject3D(id) {
    return this.modelMeshes.get(id)?.mesh
        ?? this.htmlBlocks.get(id)?.group
        ?? this.ballProxies.get(id)
        ?? null;
  }

  getObjectPosition(id) {
    return this.getObject3D(id)?.position ?? null;
  }

  getObjectPosition(id) {
    const modelEntry = this.modelMeshes.get(id);
    if (modelEntry && modelEntry.mesh) return modelEntry.mesh.position;

    const block = this.htmlBlocks.get(id);
    if (block) return block.group.position;

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
      const objA = this.getObject3D(jointBuffer[o]);
      const objB = this.getObject3D(jointBuffer[o + 1]);
      if (!objA || !objB) continue; // meshes haven't loaded yet

      // local anchor -> world: rotate by the body's orientation, then offset by its position
      this._pA.set(jointBuffer[o + 5], jointBuffer[o + 6], jointBuffer[o + 7])
        .applyQuaternion(objA.quaternion).add(objA.position);
      this._pB.set(jointBuffer[o + 8], jointBuffer[o + 9], jointBuffer[o + 10])
        .applyQuaternion(objB.quaternion).add(objB.position);

      const key = i;
      seenKeys.add(key);

      let line = this.jointLines.get(key);
      if (!line) {
        const geometry = new THREE.BufferGeometry().setFromPoints([this._pA, this._pB]);
        const material = new THREE.LineBasicMaterial({ color: 0xffaa00 });
        line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        this.scene.add(line);
        this.jointLines.set(key, line);
      } else {
        const positions = line.geometry.attributes.position;
        positions.setXYZ(0, this._pA.x, this._pA.y, this._pA.z);
        positions.setXYZ(1, this._pB.x, this._pB.y, this._pB.z);
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

  createHTML(x = 0, y = 5, z = 0, r = 1.0, path, { width = 16, height = 9, pixelWidth = 1024 } = {}) {
    if (!this.worker) return Promise.resolve(null);
    if (!path) {
      console.warn('createHTML: path is required');
      return Promise.resolve(null);
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingHtmlRequests.set(requestId, {
        resolve,
        spec: { x, y, z, depth: r, path, width, height, pixelWidth },
      });
      this.worker.postMessage({ type: 'CREATE_HTML', payload: { x, y, z, r, width, height, requestId } });
    });
  }

  buildHtmlBlock({ path, width, height, depth, pixelWidth }) {
    const pixelHeight = Math.round(pixelWidth * height / width);

    const iframe = document.createElement('iframe');
    iframe.src = path;
    iframe.style.width = `${pixelWidth}px`;
    iframe.style.height = `${pixelHeight}px`;
    iframe.style.border = '0';
    iframe.style.background = '#fff';

    const css = new CSS3DObject(iframe);
    css.scale.setScalar(width / pixelWidth);   // css px -> world units
    css.position.z = depth / 2 + 0.01;         // sit on the front (+z) face

    // BoxGeometry face order: +x, -x, +y, -y, +z, -z. Only +z is the "window".
    const solid = this.htmlSolidMaterial;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      [solid, solid, solid, solid, this.htmlHoleMaterial, solid]
    );

    const group = new THREE.Group();
    group.add(mesh, css);
    return { group, mesh, css };
  }

  createModel(x = 0, y = 5, z = 0, r = 3.0, model = 'car') {
    if (!this.worker) return Promise.resolve(null);
    if (!MODELS[model]) {
      console.warn(`createModel: unknown model "${model}"`);
      return Promise.resolve(null);
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingModelRequests.set(requestId, resolve);
      this.worker.postMessage({ type: 'CREATE_MODEL', payload: { x, y, z, r, model, requestId } });
    });
  }

  createJoint(objA, objB, restLength = 3, stiffness = 3, damping = 3, { anchorA = null, anchorB = null } = {}) {
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
      this.worker.postMessage({
        type: 'CREATE_JOINT',
        payload: { idA, idB, restLength, stiffness, damping, anchorA, anchorB, requestId },
      });
    });
  }

  setAnchored(obj, anchored) {
    if (!this.worker) return false;
    const id = typeof obj === 'number' ? obj : obj?.userData?.physicsId;
    if (id == null) {
      console.warn('anchor: could not resolve a physics id', obj);
      return false;
    }
    this.worker.postMessage({ type: 'SET_ANCHOR', payload: { id, anchored } });
    return true;
  }

  anchor(obj)   { return this.setAnchored(obj, true); }
  unanchor(obj) { return this.setAnchored(obj, false); }
}

export default new Scene();