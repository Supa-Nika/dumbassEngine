export const MODELS = {
  car: {
    obj: '/src/assets/Car.obj',
    mtl: '/src/assets/Car.mtl',
    baseSize: 3.0,
    halfExtents: { x: 1.0, y: 0.8, z: 2.2 },
  },
  // truck: {
  //   obj: '/src/assets/Truck.obj',
  //   mtl: '/src/assets/Truck.mtl',
  //   baseSize: 3.0,
  //   halfExtents: { x: 1.4, y: 1.2, z: 3.5 },
  // },
};

export const MODEL_KEYS = Object.keys(MODELS);

export const HTML_TYPE_CODE = -1; // idc its retarded and works

export const typeCodeFor = (key) => MODEL_KEYS.indexOf(key) + 1;
export const modelKeyFor = (typeCode) => MODEL_KEYS[typeCode - 1];