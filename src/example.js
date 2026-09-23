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

  const ball = await Scene.createBall(0, 5, 0, 3);
  const object = await Scene.createModel(5, 5, 5, 3, 'car');

  // Scene.setCameraFollowTarget(object);
  Scene.createJoint(ball, object, 10, 100, 10);

  const page = await Scene.createHTML(0, 25, 10, 10, '/src/assets/demo.html', { width: 96 , height: 54 });

  // Scene.anchor(page);

  // Scene.anchor( object);

  const point1 = await Scene.createBall(-10, 70, 0, 3);
  const point2 = await Scene.createBall(0, 70, 10, 3);
  const point3 = await Scene.createBall(10, 70, 0, 3);

  Scene.anchor(point1);
  Scene.anchor(point2);
  Scene.anchor(point3);

  Scene.createJoint(point1, page, 10, 5000, 1);
  Scene.createJoint(point2, page, 10, 5000, 1);
  Scene.createJoint(point3, page, 10, 5000, 1);


  // Scene.setCameraFollowTarget(point2);

  // for (let index = 0; index < 10000; index++) {
  //   const ball = await Scene.createBall(Math.random(), 5, Math.random());
  // }

  
  // const page2 = await Scene.createHTML(0, 10, 10, 5, 'slopthrowsmainidkWhy.html', { width: 200, height: 50 });
}

init();