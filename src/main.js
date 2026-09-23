import Scene from './engine/Scene.js';
import { MODEL_KEYS , typeCodeFor} from './engine/modelRegistry.js';
import Controls from './engine/Controls.js';
import * as THREE from 'three';

async function init() {
  await Scene.createScene();
  
  window.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    const key = MODEL_KEYS[Math.floor(Math.random() * MODEL_KEYS.length)];
    await Scene.createModel(mousePos.x, 5, mousePos.z, 10, key);
  });

  window.addEventListener('wheel', async (e) => {
    e.preventDefault();
    const mousePos = Controls.getMouseWorldPosition(Scene.camera);
    const r = THREE.MathUtils.randFloat(1, 5);
    const ball = await Scene.createBall(mousePos.x, 5, mousePos.z, r);
    // Scene.setCameraFollowTarget(ball);
  });

  window.addEventListener('click', () => {
    Scene.toggleRepel();
  });
  

  const ball = await Scene.createBall(0, 5, 0, 3);
  const object = await Scene.createModel(5, 5, 5, 3, 'car');
  Scene.setCameraFollowTarget(object);
  Scene.createJoint(ball, object, 10, 100, 10);
  
}

init();