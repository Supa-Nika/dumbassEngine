import { MODELS, typeCodeFor, HTML_TYPE_CODE } from './modelRegistry.js';
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


const GRAB_K = 600;                    // stiffness: the snap knob
const GRAB_C = 2 * Math.sqrt(GRAB_K);  // critical damping

let grab = null;     // { obj, planeY, offset }
let grabRay = null;

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



function updateGrab({ origin, dir, down }) {
  grabRay = { origin, dir };
  if (!down) return releaseGrab();
  if (grab) return;

  const hit = world.castRay(
    new RAPIER.Ray(origin, dir), 1000, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED
  );
  if (!hit) return;

  const body = hit.collider.parent();
  const obj = objects.find((o) => o.body.handle === body.handle);
  if (!obj) return;

  const t = hit.timeOfImpact ?? hit.toi; // name differs between rapier versions
  const pt = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
  const c = body.translation();

  // remember where on the object we grabbed so it doesn't jump to the cursor
  grab = { obj, planeY: pt.y, offset: { x: pt.x - c.x, y: pt.y - c.y, z: pt.z - c.z } };
  body.setGravityScale(0, true);
  body.setAngularDamping(5);
}

function releaseGrab() {
  if (!grab) return;
  grab.obj.body.setGravityScale(1, true);
  grab.obj.body.setAngularDamping(0);
  grab = null; // linear velocity is kept, so you can fling things
}

function applyGrab() {
  if (!grab || !grabRay) return;
  const { origin, dir } = grabRay;
  if (Math.abs(dir.y) < 1e-4) return;

  // cursor ray -> point on the horizontal drag plane
  const t = (grab.planeY - origin.y) / dir.y;
  if (t <= 0) return;

  const body = grab.obj.body;
  const p = body.translation();
  const v = body.linvel();
  const m = body.mass();

  const ax = GRAB_K * (origin.x + dir.x * t - grab.offset.x - p.x) - GRAB_C * v.x;
  const ay = GRAB_K * (origin.y + dir.y * t - grab.offset.y - p.y) - GRAB_C * v.y;
  const az = GRAB_K * (origin.z + dir.z * t - grab.offset.z - p.z) - GRAB_C * v.z;

  // multiplying by mass makes a ball and a car respond identically
  body.applyImpulse({ x: m * ax * FIXED_DT, y: m * ay * FIXED_DT, z: m * az * FIXED_DT }, true);
}

function stepPhysics() {
  applyGrab();

  world.step();

  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i].body.translation().y < -50) {
      const removedId = objects[i].id;

      if (grab?.obj.id === removedId) grab = null; // must happen before the body is removed

      world.removeRigidBody(objects[i].body);
      objects.splice(i, 1);

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
    const { body, radius, id, type, model } = objects[i];
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
    objectBuffer[idx + 9] =
      type === 'html'  ? HTML_TYPE_CODE :
      type === 'model' ? typeCodeFor(model) : 0; // i really wanted to nest these fuckers
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

  if(type === 'CREATE_HTML'){
    const spawn = { ...payload, type: 'html' };
    if (!world) {
      pendingSpawns.push(spawn);
    } else {
      const id = createBody(spawn);
      self.postMessage({ type: 'OBJECT_ID', requestId: spawn.requestId, id });
    }
  }

  if (type === 'SET_ANCHOR' && world) {
    const obj = objects.find((o) => o.id === payload.id);
    if (obj) setAnchored(obj, payload.anchored);
  }

  if (type === 'UPDATE_GRAB' && world) updateGrab(payload);
};

function createBody({ x, y, z, r, width = 16, height = 9, type = 'ball', model = null }) {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setCanSleep(false)
    .setCcdEnabled(true);

  const rigidBody = world.createRigidBody(bodyDesc);

  let colliderDesc;
  if (type === 'html') {
    // r = full depth (thickness) of the slab
    colliderDesc = RAPIER.ColliderDesc.cuboid(width / 2, height / 2, r / 2);
  } else if (type === 'model') {
    const def = MODELS[model];
    const s = r / def.baseSize;
    colliderDesc = RAPIER.ColliderDesc.cuboid(
      def.halfExtents.x * s, def.halfExtents.y * s, def.halfExtents.z * s
    );
  } else {
    colliderDesc = RAPIER.ColliderDesc.ball(r);
  }

  colliderDesc.setRestitution(0.8).setFriction(0.2);
  world.createCollider(colliderDesc, rigidBody);

  const id = nextId++;
  objects.push({ id, body: rigidBody, radius: r, type, model });
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

function setAnchored(obj, anchored) {
  const body = obj.body;

  if (grab?.obj === obj) releaseGrab(); // let go first, a frozen body can't be dragged

  if (anchored) {
    body.setLinvel({ x: 0, y: 0, z: 0 }, true); // freeze it dead, not mid-drift
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  } else {
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  }
}