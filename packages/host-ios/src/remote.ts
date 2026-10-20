import type { StoredKeyPair } from "@oxbit/sdk/tunnel";
import { native } from "./native.js";

export const REMOTE_DEVICE_KEY = "remote-device-key";

/** The remote access device key, kept in the Keychain for this device only. */
export const remoteDeviceKeyStore = {
  async load(): Promise<StoredKeyPair | undefined> {
    const { value } = await native.deviceSecret({ operation: "get", name: REMOTE_DEVICE_KEY });
    return value ? (JSON.parse(value) as StoredKeyPair) : undefined;
  },
  async save(pair: StoredKeyPair): Promise<void> {
    await native.deviceSecret({ operation: "set", name: REMOTE_DEVICE_KEY, value: JSON.stringify(pair) });
  },
};
