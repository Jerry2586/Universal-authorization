import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import type { ActivationResponseData } from '../activation.service.js';
import type { ActivationIdempotencyStore, IdempotencyClaim } from '../activation-idempotency.store.js';

interface IdempotencyRow {
  request_hash: string;
  status: 'PROCESSING' | 'COMPLETED';
  response_data: ActivationResponseData | null;
  expires_at: Date;
}

export class PostgresActivationIdempotencyStore implements ActivationIdempotencyStore {
  public constructor(private readonly database: PostgresDatabase) {}

  public async claim(input: {
    key: string;
    requestHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<IdempotencyClaim> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<IdempotencyRow>(
        `SELECT request_hash, status, response_data, expires_at
           FROM activation_idempotency_records
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [input.key],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        await client.query(
          `INSERT INTO activation_idempotency_records (
             idempotency_key, request_hash, status, started_at, expires_at
           ) VALUES ($1,$2,'PROCESSING',$3,$4)`,
          [input.key, input.requestHash, input.now, input.expiresAt],
        );
        return { kind: 'CLAIMED' };
      }

      if (row.expires_at.getTime() <= input.now.getTime()) {
        await client.query(
          `UPDATE activation_idempotency_records
              SET request_hash = $2, status = 'PROCESSING', response_data = NULL,
                  started_at = $3, completed_at = NULL, expires_at = $4
            WHERE idempotency_key = $1`,
          [input.key, input.requestHash, input.now, input.expiresAt],
        );
        return { kind: 'CLAIMED' };
      }
      if (row.request_hash !== input.requestHash) return { kind: 'CONFLICT' };
      if (row.status === 'COMPLETED' && row.response_data !== null) {
        return { kind: 'COMPLETED', response: row.response_data };
      }
      return { kind: 'PROCESSING' };
    });
  }

  public async complete(input: {
    key: string;
    requestHash: string;
    response: ActivationResponseData;
    now: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE activation_idempotency_records
          SET status = 'COMPLETED', response_data = $3::jsonb, completed_at = $4
        WHERE idempotency_key = $1 AND request_hash = $2 AND status = 'PROCESSING'`,
      [input.key, input.requestHash, JSON.stringify(input.response), input.now],
    );
  }

  public async release(key: string, requestHash: string): Promise<void> {
    await this.database.query(
      `DELETE FROM activation_idempotency_records
        WHERE idempotency_key = $1 AND request_hash = $2 AND status = 'PROCESSING'`,
      [key, requestHash],
    );
  }
}
