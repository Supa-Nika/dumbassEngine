import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import Controls from './Controls.js';

// Car is now just a static asset loader — physics lives entirely in the worker.

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

export class Car {
  static #template = null;   // cached loaded THREE.Group, cloned per spawn
  static #loadingPromise = null;

  static load(onLoad) {
    if (Car.#template) {
      onLoad(Car.#template.clone());
      return;
    }

    if (!Car.#loadingPromise) {
      Car.#loadingPromise = new Promise((resolve, reject) => {
        const mtlLoader = new MTLLoader();
        mtlLoader.load(
          '/src/assets/Car.mtl',
          (materials) => {
            materials.preload();
            const objLoader = new OBJLoader();
            objLoader.setMaterials(materials);
            objLoader.load(
              '/src/assets/Car.obj',
              (object) => {
                Car.#template = object;
                resolve(object);
              },
              (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% loaded'),
              (error) => reject(error)
            );
          },
          undefined,
          (error) => reject(error)
        );
      }).catch((error) => {
        console.error('Car asset load error:', error);
        Car.#loadingPromise = null; // allow retry on next spawn
        throw error;
      });
    }

    Car.#loadingPromise.then((template) => onLoad(template.clone()))
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
  carMeshes = new Map();
  mainCarMesh = null; 

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
      const { type, buffer } = e.data;
      if (type === 'TICK') {
        this.updateMeshFromBuffer(buffer);
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

  updateCamera() {
    if (!this.mainCarMesh) return; // no main car yet — leave camera as-is

    const car = this.mainCarMesh;

    // Offset behind and above the car, in the car's own local space,
    // then rotated into world space by the car's current heading.
    const localOffset = new THREE.Vector3(0, 6, -12); // (x, height, distance-behind)
    const desiredPos = localOffset.clone()
      .applyQuaternion(car.quaternion)
      .add(car.position);

    // Smooth follow instead of hard-snapping the camera every frame —
    // avoids jitter from the car's own rotation smoothing (smoothYaw).
    const followLerp = 0.1;
    this.camera.position.lerp(desiredPos, followLerp);

    // Look slightly ahead of/above the car rather than straight at its base.
    const lookTarget = car.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    this.camera.lookAt(lookTarget);
  }

  updateMeshFromBuffer(buffer) {
    const STRIDE = this.STRIDE;
    const count = buffer.length / STRIDE;

    let ballIndex = 0;
    const seenCarIds = new Set();

    for (let i = 0; i < count; i++) {
      const o = i * STRIDE;
      const x = buffer[o], y = buffer[o + 1], z = buffer[o + 2];
      const qx = buffer[o + 3], qy = buffer[o + 4], qz = buffer[o + 5], qw = buffer[o + 6];
      const r = buffer[o + 7];
      const id = buffer[o + 8];
      const typeCode = buffer[o + 9]; // 0 ball, 1 car, 2 mainCar
      const isCar = typeCode === 1 || typeCode === 2;

      if (isCar) {
        seenCarIds.add(id);
        let entry = this.carMeshes.get(id);

        if (!entry) {
          entry = { mesh: null, isMainCar: typeCode === 2 };
          this.carMeshes.set(id, entry);
          Car.load((object) => {
            entry.mesh = object;
            this.scene.add(object);
          });
        }

        if (entry.mesh) {
          entry.mesh.position.set(x, y, z);
          entry.mesh.quaternion.set(qx, qy, qz, qw);

          // Keep a direct reference so the render loop doesn't have to
          // search carMeshes every frame to find the main car.
          if (entry.isMainCar) {
            this.mainCarMesh = entry.mesh;
          }
        }
      } else {
        this.dummy.position.set(x, y, z);
        this.dummy.quaternion.set(qx, qy, qz, qw);
        this.dummy.scale.setScalar(r / this.baseRadius);
        this.dummy.updateMatrix();
        this.instancedMesh.setMatrixAt(ballIndex, this.dummy.matrix);
        ballIndex++;
      }
    }

    this.instancedMesh.count = ballIndex;
    this.instancedMesh.instanceMatrix.needsUpdate = true;

    for (const [id, entry] of this.carMeshes) {
      if (!seenCarIds.has(id)) {
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
        this.carMeshes.delete(id);
        // Main car fell off / was removed — stop trying to follow a stale mesh.
        if (entry.mesh === this.mainCarMesh) {
          this.mainCarMesh = null;
        }
      }
    }
  }
  
  createBall(x = 0, y = 5, z = 0, r = 3.0) {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'CREATE_BALL', payload: { x, y, z, r } });
  }

  createCar(x = 0, y = 5, z = 0, r = 3.0) {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'CREATE_CAR', payload: { x, y, z, r } });
  }

  createMainCar(x = 0, y = 5, z = 0, r = 1.0){
    if (!this.worker) return;
    this.worker.postMessage({ type: 'CREATE_MAIN_CAR', payload: { x, y, z, r } });
  }
}

export default new Scene();