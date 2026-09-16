import Scene, { Car } from './poolMinigame/Scene';
import Controls from './poolMinigame/Controls.js';
import * as THREE from 'three';

async function init() {
  await Scene.createScene();

  for (let i = 0; i < 1000; i++) {
    const r = THREE.MathUtils.randFloat(1, 2);
    // Scene.createBall(Math.random()*100 - 50, Math.random()*100, Math.random()*100 - 50, r);
    Scene.createCar(Math.random()*100 - 50, Math.random()*100, Math.random()*100 - 50, r);
    Scene.createBall(Math.random()*100 - 50, Math.random()*100, Math.random()*100 - 50, r);

  }
  
  Scene.createMainCar();

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    // const r = THREE.MathUtils.randFloat(1, 1);
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