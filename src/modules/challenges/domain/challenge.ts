export interface Challenge {
  serverNonce: string;
  productCode: string;
  clientNonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface IssuedChallenge {
  serverNonce: string;
  issuedAt: Date;
  expiresAt: Date;
  protocolVersion: 'v1';
}
