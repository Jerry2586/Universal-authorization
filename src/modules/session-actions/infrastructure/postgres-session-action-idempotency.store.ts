import type { PostgresDatabase } from '../../../infrastructure/database/postgres-database.js';
import type {
  SessionActionIdempotencyClaim,
  SessionActionIdempotencyStore,
  SessionActionResponseData,
  SessionActionType,
} from '../session-action-idempotency.store.js';

interface IdempotencyRow {
  request_hash: string;
  status: 'PROCESSING' | 'COMPLETED';
  response_data: SessionActionResponseData | null;
}

export class PostgresSessionActionIdempotencyStore implements SessionActionIdempotencyStore {
  public constructor(private readonly database: PostgresDatabase) {}

  public async claim<TResponse extends SessionActionResponseData>(input: {
    actionType: SessionActionType; key: string; requestHash: string; now: Date; expiresAt: Date;
  }): Promise<SessionActionIdempotencyClaim<TResponse>> {
    return this.database.transaction(async (client) => {
      await client.query('DELETE FROM session_action_idempotency_records WHERE expires_at <= $1', [input.now]);
      const inserted = await client.query(
        `INSERT INTO session_action_idempotency_records
           (action_type, idempotency_key, request_hash, status, started_at, expires_at)
         VALUES ($1,$2,$3,'PROCESSING',$4,$5)
         ON CONFLICT (action_type, idempotency_key) DO NOTHING`,
        [input.actionType, input.key, input.requestHash, input.now, input.expiresAt],
      );
      if ((inserted.rowCount ?? 0) > 0) return { kind: 'CLAIMED' };
      const result = await client.query<IdempotencyRow>(
        `SELECT request_hash, status, response_data
           FROM session_action_idempotency_records
          WHERE action_type = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.actionType, input.key],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: 'PROCESSING' };
      if (row.request_hash !== input.requestHash) return { kind: 'CONFLICT' };
      if (row.status === 'COMPLETED' && row.response_data !== null) {
        return { kind: 'COMPLETED', response: row.response_data as TResponse };
      }
      return { kind: 'PROCESSING' };
    });
  }

  public async complete(input: {
    actionType: SessionActionType; key: string; requestHash: string; response: SessionActionResponseData; now: Date;
  }): Promise<void> {
    await this.database.query(
      `UPDATE session_action_idempotency_records
          SET status = 'COMPLETED', response_data = $4::jsonb, completed_at = $5
        WHERE action_type = $1 AND idempotency_key = $2 AND request_hash = $3`,
      [input.actionType, input.key, input.requestHash, JSON.stringify(input.response), input.now],
    );
  }

  public async release(actionType: SessionActionType, key: string, requestHash: string): Promise<void> {
    await this.database.query(
      `DELETE FROM session_action_idempotency_records
        WHERE action_type = $1 AND idempotency_key = $2 AND request_hash = $3 AND status = 'PROCESSING'`,
      [actionType, key, requestHash],
    );
  }
}
