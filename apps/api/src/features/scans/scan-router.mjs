import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toTextStream } from "ai";
import * as repository from "../../infrastructure/repository.mjs";
import { config } from "../../core/config.mjs";
import * as copilotRepository from "../copilot/repository.mjs";
import {
  buildRemediationCopilotEvidence,
  createRemediationCopilotStream,
  isRemediationCopilotConfigured,
  remediationCopilotSchema,
  REMEDIATION_COPILOT_PROMPT_VERSION,
  REMEDIATION_COPILOT_SCHEMA_VERSION,
} from "../copilot/remediation-copilot.mjs";
import { attackPaths, policy, scenarios } from "../catalog/domain.mjs";
import { renderScanReport } from "../reports/report.mjs";
import { planLimitResponse, requireEntitlement } from "../billing/entitlement-service.mjs";

export function createScanRouter({ scanRateLimit, copilotRateLimit, recordAudit }) {
  const router = express.Router();
  router.get("/attack-paths", async (req, res, next) => {
    try {
      const billing = await repository.getBillingState(req.auth.workspaceId);
      const entitledIds = new Set(scenarios.slice(0, billing.entitlements.scenarioLimit).map((scenario) => scenario.id));
      res.json({
        paths: attackPaths.map((path) => ({
          ...path,
          locked: path.scenarioIds.some((scenarioId) => !entitledIds.has(scenarioId)),
          requiredPlan: path.scenarioIds.some((scenarioId) => !entitledIds.has(scenarioId)) ? "Builder" : "Explorer",
        })),
        entitlements: {
          scenarioLimit: billing.entitlements.scenarioLimit,
          fullScenarioSuite: billing.entitlements.fullScenarioSuite,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/agents/:agentId/attack-paths/:pathId/replay", scanRateLimit, async (req, res, next) => {
    try {
      const path = attackPaths.find((item) => item.id === req.params.pathId);
      if (!path) return res.status(404).json({ error: "Attack path not found." });
      const agent = await repository.getAgent(req.params.agentId, req.auth.workspaceId);
      if (!agent) return res.status(404).json({ error: "Agent not found." });
      if (agent.status === "quarantined") return res.status(409).json({ error: "Agent is quarantined. Restore it before replaying an attack path." });
      const scan = await repository.enqueueScan({
        workspaceId: req.auth.workspaceId,
        agentId: agent.id,
        trigger: `Attack path replay · ${path.title}`,
        scenarioIds: path.scenarioIds,
      });
      await recordAudit(req, {
        action: "attack_path.replayed",
        resourceType: "attack_path",
        resourceId: path.id,
        metadata: { agentId: agent.id, scanId: scan.id, scenarioCount: path.scenarioIds.length },
      });
      res.status(202).json({ scan, path });
    } catch (error) {
      if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED", "SCENARIO_PLAN_REQUIRED"].includes(error?.code)) {
        return planLimitResponse(req, res, error);
      }
      if (error?.code === "SCENARIO_NOT_FOUND") return res.status(404).json({ error: error.message, code: error.code });
      next(error);
    }
  });

  router.get("/scenarios", async (req, res, next) => {
    try {
      const billing = await repository.getBillingState(req.auth.workspaceId);
      const visibleScenarios = scenarios.slice(0, billing.entitlements.scenarioLimit || 0);
      res.json({
        scenarios: visibleScenarios,
        entitlements: {
          scenarioLimit: billing.entitlements.scenarioLimit,
          fullScenarioSuite: billing.entitlements.fullScenarioSuite,
          lockedScenarioCount: Math.max(0, scenarios.length - visibleScenarios.length),
        },
        policy: (await repository.getPolicy(req.auth.workspaceId)) ?? policy,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/scans", async (req, res, next) => {
    try {
      res.json({ scans: await repository.listScans(req.auth.workspaceId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/scans", scanRateLimit, async (req, res, next) => {
    try {
      const { agentId, trigger = "Manual", scenarioIds = null } = req.body ?? {};
      const agent = await repository.getAgent(agentId ?? "storefront-copilot", req.auth.workspaceId);
      if (!agent) return res.status(404).json({ error: "Agent not found." });
      if (agent.status === "quarantined") return res.status(409).json({ error: "Agent is quarantined. Restore it before starting a new scan." });
      if (agent.endpoint && /^production$/i.test(agent.environment)) {
        return res.status(409).json({
          error: "Production scans are blocked by default because a customer endpoint may execute tools internally. Use a mock/Staging endpoint or enable Runtime Firewall and test through the gateway.",
          code: "PRODUCTION_SCAN_BLOCKED",
        });
      }
      const scan = await repository.enqueueScan({
        workspaceId: req.auth.workspaceId,
        agentId: agent.id,
        trigger,
        scenarioIds,
      });
      await recordAudit(req, {
        action: "scan.created",
        resourceType: "scan",
        resourceId: scan.id,
        metadata: { agentId: agent.id, trigger },
      });
      res.status(202).json({ scan });
    } catch (error) {
      if (["SCAN_QUOTA_EXCEEDED", "SUBSCRIPTION_REQUIRED"].includes(error?.code)) {
        return planLimitResponse(req, res, error);
      }
      next(error);
    }
  });

  router.get("/scans/:scanId", async (req, res, next) => {
    try {
      const scan = await repository.getScan(req.params.scanId, req.auth.workspaceId);
      if (!scan) return res.status(404).json({ error: "Scan not found." });
      res.json({
        scan,
        policy: scan.policySnapshot?.effective ?? (await repository.getPolicy(req.auth.workspaceId)) ?? policy,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/scans/:scanId/copilot/:scenarioId", copilotRateLimit, async (req, res, next) => {
    try {
      const scan = await repository.getScan(req.params.scanId, req.auth.workspaceId);
      if (!scan) return res.status(404).json({ error: "Scan not found." });
      if (scan.status !== "completed") {
        return res.status(409).json({ error: "AI remediation is available after the scan completes.", code: "SCAN_NOT_COMPLETE" });
      }

      const result = scan.results?.find((item) => item.scenarioId === req.params.scenarioId);
      if (!result) return res.status(404).json({ error: "Scenario evidence not found in this scan." });
      if (!result.remediation || result.remediation.status === "protected") {
        return res.status(409).json({ error: "AI remediation is only available for findings that need review.", code: "COPILOT_NOT_APPLICABLE" });
      }

      const cached = await copilotRepository.getScanCopilotGuidance({
        scanId: scan.id,
        workspaceId: req.auth.workspaceId,
        scenarioId: result.scenarioId,
      });
      if (
        cached?.promptVersion === REMEDIATION_COPILOT_PROMPT_VERSION &&
        cached?.schemaVersion === REMEDIATION_COPILOT_SCHEMA_VERSION
      ) {
        const parsed = remediationCopilotSchema.safeParse(cached.guidance);
        if (parsed.success) {
          res.status(200);
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(JSON.stringify(parsed.data));
        }
      }

      if (!isRemediationCopilotConfigured()) {
        return res.status(503).json({
          error: "AI Remediation Copilot is not configured. Set AI_API_KEY and AI_MODEL on the API service.",
          code: "COPILOT_NOT_CONFIGURED",
        });
      }

      const abortController = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) abortController.abort(new Error("Client disconnected."));
      });
      const evidence = buildRemediationCopilotEvidence({ scan, result });
      const generation = createRemediationCopilotStream({
        evidence,
        abortSignal: abortController.signal,
        onError: ({ error }) => console.error(JSON.stringify({
          level: "error",
          event: "scan_copilot_generation_failed",
          requestId: req.requestId,
          scanId: scan.id,
          scenarioId: result.scenarioId,
          model: config.ai.model,
          errorName: error instanceof Error ? error.name : "UnknownError",
          statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : undefined,
        })),
      });

      res.status(200);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Accel-Buffering", "no");

      async function* guidanceStream() {
        for await (const chunk of toTextStream({ stream: generation.stream })) yield chunk;
        const guidance = remediationCopilotSchema.parse(await generation.output);
        const usage = await generation.totalUsage;
        await copilotRepository.saveScanCopilotGuidance({
          scanId: scan.id,
          workspaceId: req.auth.workspaceId,
          scenarioId: result.scenarioId,
          createdBy: req.auth.userId,
          model: config.ai.model,
          promptVersion: REMEDIATION_COPILOT_PROMPT_VERSION,
          schemaVersion: REMEDIATION_COPILOT_SCHEMA_VERSION,
          guidance,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        await recordAudit(req, {
          action: "scan.copilot.generated",
          resourceType: "scan",
          resourceId: scan.id,
          metadata: {
            scenarioId: result.scenarioId,
            model: config.ai.model,
            promptVersion: REMEDIATION_COPILOT_PROMPT_VERSION,
            schemaVersion: REMEDIATION_COPILOT_SCHEMA_VERSION,
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
          },
        });
      }

      await pipeline(Readable.from(guidanceStream()), res);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "scan_copilot_request_failed",
        requestId: req.requestId,
        scanId: req.params.scanId,
        scenarioId: req.params.scenarioId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      if (!res.headersSent && !res.destroyed) {
        return res.status(502).json({ error: "AI remediation could not be generated. Please retry.", code: "COPILOT_GENERATION_FAILED" });
      }
      if (!res.destroyed) res.destroy();
    }
  });

  router.get("/scans/:scanId/report", async (req, res, next) => {
    try {
      const scan = await repository.getScan(req.params.scanId, req.auth.workspaceId);
      if (!scan) return res.status(404).json({ error: "Scan not found." });
      const agent = await repository.getAgent(scan.agentId, req.auth.workspaceId);
      const isQuickstartPreview = agent?.mode === "demo_simulator" && scan.trigger === "Quickstart demo";
      const billing = await repository.getBillingState(req.auth.workspaceId);
      const isFirstFreePreview = billing.plan.id === "free"
        && scan.status === "completed"
        && await repository.isFirstCompletedScan({ scanId: scan.id, workspaceId: req.auth.workspaceId });
      if (!isQuickstartPreview && !isFirstFreePreview && !(await requireEntitlement(req, res, "exportReports", "Shareable security reports require Builder or a higher plan."))) return;
      const workspacePolicy = scan.policySnapshot?.effective ?? (await repository.getPolicy(req.auth.workspaceId)) ?? policy;
      const reportPolicy = isQuickstartPreview
        ? { ...workspacePolicy, name: "Quickstart refund policy", maxAmount: 50, maxAgeDays: 14, currency: "USD" }
        : workspacePolicy;
      const report = renderScanReport({
        scan,
        policy: reportPolicy,
        preview: isQuickstartPreview || isFirstFreePreview,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="agentguard-${scan.id}.html"`);
      res.send(report);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
