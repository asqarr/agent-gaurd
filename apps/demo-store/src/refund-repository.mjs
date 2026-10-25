import { Pool } from "pg";

const DEFAULT_SCHEMA = "agentguard_demo_store";

export class DemoStoreReplayError extends Error {
  constructor() {
    super("This one-time execution receipt has already been used.");
    this.name = "DemoStoreReplayError";
    this.code = "EXECUTION_RECEIPT_REPLAYED";
    this.status = 409;
  }
}

function mapRefund(row) {
  return {
    id: `demo-refund-${row.id}`,
    orderId: row.order_id,
    amount: Number(row.amount),
    currency: row.currency,
    approvalId: row.approval_id,
    requestId: row.request_id,
    executedAt: new Date(row.executed_at).toISOString(),
  };
}

export function createRefundRepository({
  databaseUrl = process.env.DEMO_STORE_DATABASE_URL ?? process.env.DATABASE_URL ??
    "postgresql://agentguard:agentguard@127.0.0.1:5432/agentguard",
  schema = process.env.DEMO_STORE_SCHEMA ?? DEFAULT_SCHEMA,
} = {}) {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError("Demo Store database schema must be a simple PostgreSQL identifier.");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    application_name: "agentguard-demo-store",
  });
  let initialized = false;

  return {
    async initialize() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agentguard-demo-store-schema:${schema}`]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${schema}.consumed_approvals (
            approval_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            tool TEXT NOT NULL CHECK (tool = 'issue_refund'),
            order_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 50),
            currency TEXT NOT NULL CHECK (currency = 'USD'),
            consumed_at TIMESTAMPTZ NOT NULL
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${schema}.refunds (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            approval_id TEXT NOT NULL UNIQUE
              REFERENCES ${schema}.consumed_approvals (approval_id),
            order_id TEXT NOT NULL,
            amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 50),
            currency TEXT NOT NULL CHECK (currency = 'USD'),
            request_id TEXT NOT NULL,
            executed_at TIMESTAMPTZ NOT NULL
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS demo_store_refunds_order_created_idx
          ON ${schema}.refunds (order_id, executed_at DESC)
        `);
        await client.query("COMMIT");
        initialized = true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async createRefund(record) {
      if (!initialized) throw new Error("Demo Store refund repository is not initialized.");
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;

        const consumed = await client.query(
          `INSERT INTO ${schema}.consumed_approvals
            (approval_id, agent_id, request_id, tool, order_id, tenant_id, amount, currency, consumed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (approval_id) DO NOTHING
           RETURNING approval_id`,
          [
            record.approvalId,
            record.agentId,
            record.requestId,
            record.tool,
            record.orderId,
            record.tenantId,
            record.amount,
            record.currency,
            record.consumedAt,
          ],
        );

        if (consumed.rowCount !== 1) {
          await client.query("ROLLBACK");
          inTransaction = false;
          throw new DemoStoreReplayError();
        }

        const inserted = await client.query(
          `INSERT INTO ${schema}.refunds
            (approval_id, order_id, amount, currency, request_id, executed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, approval_id, order_id, amount, currency, request_id, executed_at`,
          [record.approvalId, record.orderId, record.amount, record.currency, record.requestId, record.executedAt],
        );
        await client.query("COMMIT");
        inTransaction = false;
        return mapRefund(inserted.rows[0]);
      } catch (error) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => {});
        if (error?.code === "23505") throw new DemoStoreReplayError();
        throw error;
      } finally {
        client.release();
      }
    },

    async listRefunds() {
      if (!initialized) throw new Error("Demo Store refund repository is not initialized.");
      const result = await pool.query(
        `SELECT id, approval_id, order_id, amount, currency, request_id, executed_at
         FROM ${schema}.refunds
         ORDER BY id ASC`,
      );
      return result.rows.map(mapRefund);
    },

    close() {
      return pool.end();
    },
  };
}
