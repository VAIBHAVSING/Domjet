let nextBrowserId = 1;
let restored = null;

const emptyFrames = () => new Uint8Array();

module.exports = {
  cdpRawAbiVersion() {
    return 1;
  },
  browserCreate() {
    return nextBrowserId++;
  },
  browserClose() {},
  connectionOpen() {
    return 1;
  },
  connectionClose() {},
  contextExport() {
    return new Uint8Array(restored?.bytes ?? []);
  },
  contextImport(_browserId, snapshot) {
    restored = { browserId: _browserId, contextId: 7, bytes: Array.from(snapshot) };
    return 7;
  },
  contextRestore(browserId, contextId, snapshot) {
    restored = { browserId, contextId, bytes: Array.from(snapshot) };
  },
  cdpIngest() {
    return new Uint8Array([2, 0, 0, 0, 123, 125]);
  },
  cdpDrainEvents: emptyFrames,
  cdpDrainActions: emptyFrames,
  cdpCompleteActions: emptyFrames,
  cdpOpenStream() {
    return "stream-1";
  },
  cdpRecordNetwork() {},
  cdpInterceptFetch() {
    return new TextEncoder().encode('{"paused":false}');
  },
  cdpDrainFetchResolutions: emptyFrames,
  cdpCacheDisabled() {
    return false;
  },
  cdpClearResponseCache() {},
  cdpCancelFetch() {},
  probe() {
    return JSON.stringify({ restored });
  },
};
