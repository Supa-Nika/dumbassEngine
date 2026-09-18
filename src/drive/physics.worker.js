import RAPIER, { Vector3 } from '@dimforge/rapier3d-compat';


let world = null;

// Single source of truth for every simulated body, instead of four
// parallel arrays (bodies/radii/types/ids) that had to be kept in sync
// by index on every push/splice.
const objects = []; // { id, body, radius, type: 'ball' | 'car' | 'mainCar' }
let nextId = 0;

const TYPE_CODE = { ball: 0, car: 1, mainCar: 2 };

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

// Was `const keys = {...}`, then UPDATE_MAIN_CAR did `keys = payload.keys`
// — an assignment to a const, which throws inside onmessage and silently
// kills that message (no try/catch around it), so input never applied.
let keys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false, ShiftLeft: false };

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

  applyMainCarControls();

  world.step();

  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i].body.translation().y < -50) {
      world.removeRigidBody(objects[i].body);
      objects.splice(i, 1);
    }
  }
}


function vec3Magnitude(vec3){
  return Math.sqrt(vec3.x*vec3.x+ vec3.y*vec3.y + vec3.z*vec3.z);
}

function vec3Normalize(vec3){
  let mag = vec3Magnitude(vec3);
  return new Vector3(vec3.x/mag, vec3.y/mag, vec3.z/mag);
}

// function vec3Rotate2D(vec3, rad){
//   const x = (Math.cos(rad) - Math.sin(rad)) * vec3.x;
//   const z = (Math.sin(rad) - Math.cos(rad)) * vec3.z;
//   return new Vector3(x, vec3.y, z);
// }

let steeringAngle = 0; 

function applyMainCarControls(delta = 1 / 60) {
  const mainCar = objects.find((o) => o.type === 'mainCar');
  if (!mainCar) return;


  mainCar.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  let accel = 0.3;                 // Increased from 0.3 for fast arcade acceleration
  const maxSteer = Math.PI / 3.5;     // Wider max steer angle (~51 degrees)
  const steerSpeed = 3.0 * delta;    // Snappy steering response (was 0.2 * delta)
  const steerReturn = 12.0 * delta;

  const rot = mainCar.body.rotation();
  const currentYaw = Math.atan2(
    2 * (rot.w * rot.y + rot.x * rot.z),
    1 - 2 * (rot.y * rot.y + rot.x * rot.x)
  );

  const vel = mainCar.body.linvel();
  const speed = Math.hypot(vel.x, vel.z);

  const minSpeed = 10;
  const optimalSpeed = minSpeed * 10;
  let maxSpeed = 120;
  const floorFactor = 0.15;
  const peakFactor = 0.4;

  let turnFactor;
  if (speed <= minSpeed) {
    turnFactor = floorFactor * (speed / minSpeed);
  } else if (speed <= optimalSpeed) {
    const t = (speed - minSpeed) / (optimalSpeed - minSpeed);
    turnFactor = floorFactor + (peakFactor - floorFactor) * t;
  } else if (speed <= maxSpeed) {
    const t = (speed - optimalSpeed) / (maxSpeed - optimalSpeed);
    turnFactor = peakFactor - (peakFactor - floorFactor) * t;
  } else {
    turnFactor = floorFactor;
  }

  if(keys.ShiftLeft) {
    accel = 10;
    maxSpeed = 100000;
  }
  const driftMinSpeed = minSpeed * 0.8;
  const isDrifting = keys.Space && speed > driftMinSpeed;

  const baseTraction = 0.85;
  const driftTraction = 0.15;
  const driftTurnBoost = 5;
  const traction = isDrifting ? driftTraction : baseTraction;
  const effectiveTurnFactor = isDrifting ? turnFactor * driftTurnBoost : turnFactor;

  if (keys.KeyA) steeringAngle += steerSpeed * turnFactor;
  else if (keys.KeyD) steeringAngle -= steerSpeed * turnFactor;
  else steeringAngle *= Math.max(0, 1 - steerReturn);

  steeringAngle = Math.max(-maxSteer, Math.min(maxSteer, steeringAngle));

  const targetYaw = currentYaw + steeringAngle;
  const forward = new Vector3(Math.sin(currentYaw), 0, Math.cos(currentYaw));
  const right = new Vector3(forward.z, 0, -forward.x);

  const forwardSpeed = vel.x * forward.x + vel.z * forward.z;
  const lateralSpeed = vel.x * right.x + vel.z * right.z;
  const dampedLateral = lateralSpeed * (1 - traction);

  mainCar.body.setLinvel(
    {
      x: forward.x * forwardSpeed + right.x * dampedLateral,
      y: vel.y,
      z: forward.z * forwardSpeed + right.z * dampedLateral,
    },
    true
  );

  let move = 0;
  if (keys.KeyW) move = 1;
  else if (keys.KeyS) move = -0.5;

  if (move !== 0) {
    mainCar.body.applyImpulse(
      { x: forward.x * accel * move, y: 0, z: forward.z * accel * move },
      true
    );
  }

  if (speed > 0.01) {
    const turnLerp = Math.min(1, effectiveTurnFactor * delta * 10);
    const smoothYaw = currentYaw + (targetYaw - currentYaw) * turnLerp;
    mainCar.body.setRotation(
      { x: 0, y: Math.sin(smoothYaw / 2), z: 0, w: Math.cos(smoothYaw / 2) },
      true
    );
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
      createBody(pendingSpawns.shift());
    }

    self.postMessage({ type: 'READY' });
    startLoop();
  }

  if (type === 'CREATE_BALL') {
    const spawn = { ...payload, type: 'ball' };
    if (!world) pendingSpawns.push(spawn); else createBody(spawn);
  }

  if (type === 'CREATE_CAR') {
    const spawn = { ...payload, type: 'car' };
    if (!world) pendingSpawns.push(spawn); else createBody(spawn);
  }

  if (type === 'CREATE_MAIN_CAR') {
    // Only one main car makes sense — otherwise applyMainCarControls()
    // would just grab whichever one Array#find hits first.
    const alreadyHasMainCar =
      objects.some((o) => o.type === 'mainCar') ||
      pendingSpawns.some((s) => s.type === 'mainCar');
    if (alreadyHasMainCar) return;

    const spawn = { ...payload, type: 'mainCar' };
    if (!world) pendingSpawns.push(spawn); else createBody(spawn);
  }

  if (type === 'UPDATE_REPEL') {
    mousePos = payload.mousePos;
    repelRadius = payload.radius ?? repelRadius;
    repelStrength = payload.strength ?? repelStrength;
  }

  if (type === 'UPDATE_MAIN_CAR') {
    keys = payload.keys;
  }
};

function createBody({ x, y, z, r, type = 'ball' }) {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setCanSleep(true)
    .setCcdEnabled(true);

  if (type === 'car' || type === 'mainCar') {
    bodyDesc.enabledRotations(false, true, false);
  }

  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.ball(r)
    .setRestitution(0.8)
    .setFriction(0.2);

  world.createCollider(colliderDesc, body);

  objects.push({ id: nextId++, body, radius: r, type });
}