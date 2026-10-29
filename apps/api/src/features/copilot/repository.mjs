import { randomUUID } from "node:crypto";
import { query } from "../../core/db.mjs";

function mapGuidance(row) {
  if (!row) return null;
  return {
    guidance: row.guidance,
    model: row.model_id,
    generatedAt: row.created_at,
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
  };
}

export async function getScanCopilotGuidance({ scanId, workspaceId, scenarioId }) {
  const result = await query(
    `SELECT g.guidance, g.model_id, g.created_at, g.input_tokens, g.output_tokens,
            g.prompt_version, g.schema_version
     FROM scan_copilot_guidance g
     JOIN scans s ON s.id = g.scan_id AND s.workspace_id = g.workspace_id
     WHERE g.scan_id = $1 AND g.workspace_id = $2 AND g.scenario_id = $3`,
    [scanId, workspaceId, scenarioId],
  );
  return mapGuidance(result.rows[0]);
}

export async function saveScanCopilotGuidance({
  scanId,
  workspaceId,
  scenarioId,
  createdBy,
  model,
  promptVersion,
  schemaVersion,
  guidance,
  inputTokens,
  outputTokens,
}) {
  const inserted = await query(
    `INSERT INTO scan_copilot_guidance
       (id, workspace_id, scan_id, scenario_id, created_by, model_id,
        prompt_version, schema_version, guidance, input_tokens, output_tokens)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
     WHERE EXISTS (SELECT 1 FROM scans WHERE id=$3 AND workspace_id=$2)
     ON CONFLICT (scan_id, scenario_id) DO UPDATE SET
       created_by=EXCLUDED.created_by,
       model_id=EXCLUDED.model_id,
       prompt_version=EXCLUDED.prompt_version,
       schema_version=EXCLUDED.schema_version,
       guidance=EXCLUDED.guidance,
       input_tokens=EXCLUDED.input_tokens,
       output_tokens=EXCLUDED.output_tokens,
       created_at=NOW()
     RETURNING guidance, model_id, created_at, input_tokens, output_tokens,
               prompt_version, schema_version`,
    [
      `copilot-${randomUUID()}`,
      workspaceId,
      scanId,
      scenarioId,
      createdBy ?? null,
      model,
      promptVersion,
      schemaVersion,
      JSON.stringify(guidance),
      Number.isInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
      Number.isInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null,
    ],
  );
  if (inserted.rowCount) return mapGuidance(inserted.rows[0]);
  throw new Error("Scan evidence expired before its AI remediation could be saved.");
}
