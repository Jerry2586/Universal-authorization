import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

export interface PostgresDatabaseOptions {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  applicationName: string;
  onError?: (error: Error) => void;
}

export class PostgresDatabase {
  private readonly pool: Pool;

  public constructor(options: PostgresDatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      application_name: options.applicationName,
    });

    this.pool.on('error', (error) => {
      options.onError?.(error);
    });
  }

  public async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async ping(): Promise<number> {
    const startedAt = performance.now();
    await this.pool.query('SELECT 1');
    return Math.round((performance.now() - startedAt) * 100) / 100;
  }

  public async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values);
  }

  public async withConnection<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  public async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withConnection(async (client) => {
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
