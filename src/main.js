import Scene from './drive/Scene.js';
import Controls from './drive/Controls.js';
import * as THREE from 'three';

async function init() {
  await Scene.createScene();
  
  window.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    const object = await Scene.createModel(mousePos.x, 5, mousePos.z, 10);
    Scene.setCameraFollowTarget(object);
  });

  window.addEventListener('click', async (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    const r = THREE.MathUtils.randFloat(1, 5);
    const ball = await Scene.createBall(mousePos.x, 5, mousePos.z, r);
    Scene.setCameraFollowTarget(ball);
  });
}

init();