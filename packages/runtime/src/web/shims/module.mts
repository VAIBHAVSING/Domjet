// @ts-nocheck
export function createRequire() {
  return () => { throw new Error("require() is not available in this runtime"); };
}
export default { createRequire };
