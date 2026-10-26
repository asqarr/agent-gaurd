import express from "express";
import * as repository from "../../infrastructure/repository.mjs";
import { attackPaths, policy, scenarios } from "../catalog/domain.mjs";
import { renderScanReport } from "../reports/report.mjs";
import { planLimitResponse, requireEntitlement } from "../billing/entitlement-service.mjs";

export function createScanRouter({ scanRateLimit, recordAudit }) {
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
