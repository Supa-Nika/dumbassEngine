import RAPIER from '@dimforge/rapier3d-compat';

let world = null;

const objects = [];
let nextId = 0;

const relations = [];
let nextJointId = 0;

const TYPE_CODE = { ball: 0, model: 1 };

const MODEL_BASE_HALF_EXTENTS = { x: 1.0, y: 0.6, z: 2.2 };
const MODEL_BASE_SIZE = 3.0;

const pendingSpawns = [];

const pendingJoints = [];

let mousePos = null;
let repelRadius = 5;
let repelStrength = 10;

const FIXED_DT = 1 / 120;        // seconds of sim time consumed per physics step
const TIME_SCALE = 2.0;
const MAX_STEPS_PER_TICK = 5;
const STRIDE = 10; // x,y,z, qx,qy,qz,qw, r, id, typeCode
const JOINTSTRIDE = 5; // idA, idB, restLength, stiffness, damping

let lastTime = null;
let accumulator = 0;

function startLoop() {
  lastTime = performance.now();
  setInterval(tick, 1000 / 60);
}

function tick() {
  const now = performance.now();
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;

  frameTime = Math.min(frameTime, 0.25);
  accumulator += frameTime * TIME_SCALE;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_TICK) {
    stepPhysics();
    accumulator -= FIXED_DT;
    steps++;
  }

  if (steps > 0) sendTick();
}

function stepPhysics() {
  if (mousePos) {
    for (const obj of objects) {
      const pos = obj.body.translation();
      const dx = pos.x - mousePos.x;
      const dz = pos.z - mousePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < repelRadius && dist > 0.001) {
        const force = (1 - dist / repelRadius) * repelStrength;
        obj.body.applyImpulse({ x: (dx / dist) * force, y: 0, z: (dz / dist) * force }, true);
      }
    }
  }

  world.step();

  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i].body.translation().y < -50) {
      const removedId = objects[i].id;
      world.removeRigidBody(objects[i].body); // Rapier also drops any impulse joints on this body
      objects.splice(i, 1);

      // Keep our bookkeeping in sync so we stop reporting dead joints to the main thread.
      for (let j = relations.length - 1; j >= 0; j--) {
        if (relations[j].idA === removedId || relations[j].idB === removedId) {
          relations.splice(j, 1);
        }
      }
    }
  }
}

function sendTick() {
  const objectBuffer = new Float32Array(objects.length * STRIDE);
  for (let i = 0; i < objects.length; i++) {
    const { body, radius, id, type } = objects[i];
    const pos = body.translation();
    const rot = body.rotation();
    const idx = i * STRIDE;
    objectBuffer[idx] = pos.x;
    objectBuffer[idx + 1] = pos.y;
    objectBuffer[idx + 2] = pos.z;
    objectBuffer[idx + 3] = rot.x;
    objectBuffer[idx + 4] = rot.y;
    objectBuffer[idx + 5] = rot.z;
    objectBuffer[idx + 6] = rot.w;
    objectBuffer[idx + 7] = radius;
    objectBuffer[idx + 8] = id;
    objectBuffer[idx + 9] = TYPE_CODE[type];
  }

  const jointBuffer = new Float32Array(relations.length * JOINTSTRIDE);
  for (let i = 0; i < relations.length; i++) {
    const { idA, idB, restLength, stiffness, damping } = relations[i];
    const idx = i * JOINTSTRIDE;
    jointBuffer[idx] = idA;
    jointBuffer[idx + 1] = idB;
    jointBuffer[idx + 2] = restLength ?? 3;
    jointBuffer[idx + 3] = stiffness ?? 3;
    jointBuffer[idx + 4] = damping ?? 3;
  }

  self.postMessage(
    { type: 'TICK', objectBuffer, jointBuffer },
    [objectBuffer.buffer, jointBuffer.buffer]
  );
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    await RAPIER.init();

    const gravity = { x: 0.0, y: -9.81, z: 0 };
    world = new RAPIER.World(gravity);
    world.timestep = FIXED_DT;

    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -3, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(500, 0.1, 500).setRestitution(0.8),
      groundBody
    );

    while (pendingSpawns.length > 0) {
      const spawn = pendingSpawns.shift();
      const id = createBody(spawn);
      self.postMessage({ type: 'OBJECT_ID', requestId: spawn.requestId, id });
    }

    // Bodies now exist, so any joints that were requested before INIT can be resolved.
    while (pendingJoints.length > 0) {
      const joint = pendingJoints.shift();
      const id = createJoint(joint.idA, joint.idB, joint.restLength, joint.stiffness, joint.damping);
      self.postMessage({ type: 'JOINT_ID', requestId: joint.requestId, id });
    }

    self.postMessage({ type: 'READY' });
    startLoop();
  }

  if (type === 'CREATE_BALL') {
    const spawn = { ...payload, type: 'ball' };
    if (!world) {
      pendingSpawns.push(spawn);
    } else {
      const id = createBody(spawn);
      self.postMessage({ type: 'OBJECT_ID', requestId: spawn.requestId, id });
    }
  }

  if (type === 'CREATE_MODEL') {
    const spawn = { ...payload, type: 'model' };
    if (!world) {
      pendingSpawns.push(spawn);
    } else {
      const id = createBody(spawn);
      self.postMessage({ type: 'OBJECT_ID', requestId: spawn.requestId, id });
    }
  }

  if (type === 'CREATE_JOINT') {
    const { idA, idB, restLength, stiffness, damping, requestId } = { ...payload };
    if (!world) {
      pendingJoints.push({ idA, idB, restLength, stiffness, damping, requestId });
    } else {
      const id = createJoint(idA, idB, restLength, stiffness, damping);
      self.postMessage({ type: 'JOINT_ID', requestId, id });
    }
  }

  if (type === 'UPDATE_REPEL') {
    mousePos = payload.mousePos;
    repelRadius = payload.radius ?? repelRadius;
    repelStrength = payload.strength ?? repelStrength;
  }
};

function createBody({ x, y, z, r, type = 'ball' }) {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setCanSleep(false)
    .setCcdEnabled(true);

  const rigidBody = world.createRigidBody(bodyDesc);

  const scale = r / MODEL_BASE_SIZE;
  const colliderDesc = type === 'model'
    ? RAPIER.ColliderDesc.cuboid(
        MODEL_BASE_HALF_EXTENTS.x * scale,
        MODEL_BASE_HALF_EXTENTS.y * scale,
        MODEL_BASE_HALF_EXTENTS.z * scale
      )
    : RAPIER.ColliderDesc.ball(r);

  colliderDesc.setRestitution(0.8).setFriction(0.2);
  world.createCollider(colliderDesc, rigidBody);

  const id = nextId++;
  objects.push({ id, body: rigidBody, radius: r, type });
  return id;
}

function createJoint(idA, idB, restLength = 5.0, stiffness = 50.0, damping = 2.0) {
  const objA = objects.find((o) => o.id === idA);
  const objB = objects.find((o) => o.id === idB);

  if (!objA || !objB) {
    console.warn(`createJoint: could not find bodies for ids ${idA}, ${idB}`);
    return null;
  }

  const anchor1 = { x: 0.0, y: 0.0, z: 0.0 };
  const anchor2 = { x: 0.0, y: 0.0, z: 0.0 };

  const params = RAPIER.JointData.spring(restLength, stiffness, damping, anchor1, anchor2);
  const impulseJoint = world.createImpulseJoint(params, objA.body, objB.body, true);

  const id = nextJointId++;
  relations.push({ id, idA, idB, restLength, stiffness, damping, joint: impulseJoint });
  return id;
}