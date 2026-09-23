import * as THREE from 'three';

const keys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false, ShiftLeft: false };

class Controls {
  static worker = null;

  static setWorker(workerInstance) {
    Controls.worker = workerInstance;
  }

  static mouse = new THREE.Vector2(10000, 10000);
  static raycaster = new THREE.Raycaster();
  static targetPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  static worldPosition = new THREE.Vector3();

  static get keys() {
    return keys;
  }

  static getMouseWorldPosition(camera) {
    Controls.raycaster.setFromCamera(Controls.mouse, camera);
    Controls.raycaster.ray.intersectPlane(Controls.targetPlane, Controls.worldPosition);
    return Controls.worldPosition;
  }

  static mainCarInput() {
    if (!Controls.worker) return;

    // Send a plain copy of keys object
    Controls.worker.postMessage({
      type: 'UPDATE_MAIN_CAR',
      payload: { keys: { ...keys } }
    });
  }

  static down = false;

  static sendGrabUpdate(camera) {
    if (!Controls.worker) return;
    Controls.raycaster.setFromCamera(Controls.mouse, camera);
    const { origin, direction } = Controls.raycaster.ray;
    Controls.worker.postMessage({
      type: 'UPDATE_GRAB',
      payload: {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        dir: { x: direction.x, y: direction.y, z: direction.z },
        down: Controls.down,
      },
    });
  }
}

window.addEventListener('pointermove', (event) => {
  Controls.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  Controls.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('keydown', (event) => {
  if (event.code in keys) {
    keys[event.code] = true;
    Controls.mainCarInput();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code in keys) {
    keys[event.code] = false;
    Controls.mainCarInput();
  }
});

// with your other listeners
window.addEventListener('pointerdown', () => { Controls.down = true; });
window.addEventListener('pointerup', () => { Controls.down = false; });
window.addEventListener('pointercancel', () => { Controls.down = false; });
window.addEventListener('blur', () => { Controls.down = false; });

export default Controls;