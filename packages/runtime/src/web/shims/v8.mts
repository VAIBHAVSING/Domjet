// @ts-nocheck
// node:v8 on the web: no heap statistics or flags. Zeros keep the memory
// snapshot shape stable; the forced-collection path reports "unavailable".
export function getHeapStatistics() {
  return { total_heap_size: 0, total_physical_size: 0, used_heap_size: 0, heap_size_limit: 0, malloced_memory: 0, peak_malloced_memory: 0, external_memory: 0 };
}
export function setFlagsFromString() {}
export default { getHeapStatistics, setFlagsFromString };
