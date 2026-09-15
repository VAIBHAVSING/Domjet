export {
  default,
  local,
  openProfile,
  ProfileConflictError,
  ProfileCorruptError,
  sealProfile,
} from "./internal/storage.mjs";

export type {
  LocalStoreOptions,
  ProfileCodecOptions,
  ProfileStore,
  StoredProfile,
  StoreReadOptions,
  StoreWriteOptions,
} from "./internal/storage.mjs";
