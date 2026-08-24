export interface RequestReplayStore {
  claim(input: {
    deviceId: string;
    clientNonce: string;
    requestHash: string;
    ttlSeconds: number;
  }): Promise<boolean>;
}
