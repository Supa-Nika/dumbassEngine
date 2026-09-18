import Scene, { Car } from './drive/Scene.js';
import Controls from './drive/Controls.js';
import * as THREE from 'three';

async function init() {
  await Scene.createScene();

  Scene.createMainCar();

  // ADD: load real-world buildings around a lat/lon, e.g. Times Square
  
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    Scene.createCar(mousePos.x, 5, mousePos.z, 1);
  });

  window.addEventListener('click', (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    const r = THREE.MathUtils.randFloat(1, 5);
    Scene.createBall(mousePos.x, 5, mousePos.z, r);
  });
}

init();