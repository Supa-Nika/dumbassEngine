import RAPIER from '@dimforge/rapier3d-compat';


let world = null;

const objects = [];
let nextId = 0;

const TYPE_CODE = { ball: 0, model: 1 };

const MODEL_BASE_HALF_EXTENTS = { x: 1.0, y: 0.6, z: 2.2 };
const MODEL_BASE_SIZE = 3.0;

const pendingSpawns = [];
let mousePos = null;
let repelRadius = 5;
let repelStrength = 10;

const FIXED_DT = 1 / 120;        // seconds of sim time consumed per physics step
const TIME_SCALE = 2.0;
const MAX_STEPS_PER_TICK = 5;
const STRIDE = 10; // x,y,z, qx,qy,qz,qw, r, id, typeCode

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
      world.removeRigidBody(objects[i].body);
      objects.splice(i, 1);
    }
  }
}

function sendTick() {
  const buffer = new Float32Array(objects.length * STRIDE);
  for (let i = 0; i < objects.length; i++) {
    const { body, radius, id, type } = objects[i];
    const pos = body.translation();
    const rot = body.rotation();
    const idx = i * STRIDE;
    buffer[idx] = pos.x;
    buffer[idx + 1] = pos.y;
    buffer[idx + 2] = pos.z;
    buffer[idx + 3] = rot.x;
    buffer[idx + 4] = rot.y;
    buffer[idx + 5] = rot.z;
    buffer[idx + 6] = rot.w;
    buffer[idx + 7] = radius;
    buffer[idx + 8] = id;
    buffer[idx + 9] = TYPE_CODE[type];
  }
  self.postMessage({ type: 'TICK', buffer }, [buffer.buffer]);
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