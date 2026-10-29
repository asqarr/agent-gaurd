import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { performance } from "node:perf_hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";

process.env.OTEL_SERVICE_NAME ??= "agentguard-api";

const hasOtlpEndpoint = Boolean(
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);
const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME,
  ...(hasOtlpEndpoint
    ? { traceExporter: new OTLPTraceExporter() }
    : { spanProcessors: [] }),
});
const tracer = trace.getTracer("agentguard.runtime", "1.0.0");
let sdkStarted = false;

export function startRuntimeTelemetry() {
  if (sdkStarted) return;
  sdk.start();
  sdkStarted = true;
}

export async function shutdownRuntimeTelemetry() {
  if (!sdkStarted) return;
  sdkStarted = false;
  await sdk.shutdown();
}

function traceparentFor(spanContext) {
  if (!spanContext?.traceId || !spanContext?.spanId) return null;
  const flags = Number(spanContext.traceFlags ?? 0).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function recordSpan({ span, parentSpanId, name, stage, startedAt, startedAtMs, outcome, decision, toolCount }) {
  const spanContext = span.spanContext();
  span.setAttribute("agentguard.stage", stage);
  span.setAttribute("agentguard.outcome", outcome);
  if (decision === "ALLOW" || decision === "BLOCK") {
    span.setAttribute("agentguard.decision", decision);
  }
  if (Number.isInteger(toolCount) && toolCount >= 0) {
    span.setAttribute("agentguard.tool_count", toolCount);
  }
  span.setStatus({ code: outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  const durationMs = Math.max(0, Math.round(performance.now() - startedAtMs));
  span.end();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: parentSpanId ?? null,
    name,
    stage,
    outcome,
    ...(decision === "ALLOW" || decision === "BLOCK" ? { decision } : {}),
    ...(Number.isInteger(toolCount) && toolCount >= 0 ? { toolCount } : {}),
    startedAt,
    durationMs,
  };
}

export function createRuntimeTrace({ parentTraceparent } = {}) {
  const carrier = typeof parentTraceparent === "string" && parentTraceparent.length <= 256
    ? { traceparent: parentTraceparent }
    : {};
  const parentContext = propagation.extract(context.active(), carrier);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const root = tracer.startSpan("agentguard.runtime.invoke", { kind: SpanKind.SERVER }, parentContext);
  const rootContext = trace.setSpan(parentContext, root);
  const rootSpanContext = root.spanContext();
  const childSpans = [];
  let finished = false;
  let finishedValue = null;

  return {
    traceId: rootSpanContext.traceId,
    rootSpanId: rootSpanContext.spanId,
    traceparent: traceparentFor(rootSpanContext),
    traceContext: {
      traceId: rootSpanContext.traceId,
      spanId: rootSpanContext.spanId,
      traceFlags: rootSpanContext.traceFlags,
    },
    async measure({ name, stage, kind = SpanKind.INTERNAL, outcome = () => "completed", decision, toolCount }, operation) {
      const childStartedAt = new Date().toISOString();
      const childStartedAtMs = performance.now();
      const span = tracer.startSpan(name, { kind }, rootContext);
      const spanContext = span.spanContext();
      let result;
      let spanOutcome = "error";
      let spanDecision = decision;
      let spanToolCount = toolCount;
      try {
        result = await context.with(trace.setSpan(rootContext, span), () => operation({
          traceparent: traceparentFor(spanContext),
        }));
        const projectedOutcome = typeof outcome === "function" ? outcome(result) : outcome;
        spanOutcome = typeof projectedOutcome === "string" ? projectedOutcome : "completed";
        spanDecision = typeof decision === "function" ? decision(result) : decision;
        spanToolCount = typeof toolCount === "function" ? toolCount(result) : toolCount;
        childSpans.push(recordSpan({
          span,
          parentSpanId: rootSpanContext.spanId,
          name,
          stage,
          startedAt: childStartedAt,
          startedAtMs: childStartedAtMs,
          outcome: spanOutcome,
          decision: spanDecision,
          toolCount: spanToolCount,
        }));
        return result;
      } catch (error) {
        childSpans.push(recordSpan({
          span,
          parentSpanId: rootSpanContext.spanId,
          name,
          stage,
          startedAt: childStartedAt,
          startedAtMs: childStartedAtMs,
          outcome: "error",
          decision: spanDecision,
          toolCount: spanToolCount,
        }));
        throw error;
      }
    },
    finish({ outcome = "completed", decision, toolCount } = {}) {
      if (finished) {
        const rootRecord = finishedValue.traceSpans[0];
        rootRecord.outcome = outcome;
        if (decision === "ALLOW" || decision === "BLOCK") rootRecord.decision = decision;
        if (Number.isInteger(toolCount) && toolCount >= 0) rootRecord.toolCount = toolCount;
        return finishedValue;
      }
      finished = true;
      finishedValue = {
        traceId: rootSpanContext.traceId,
        rootSpanId: rootSpanContext.spanId,
        traceSpans: [
          recordSpan({
            span: root,
            parentSpanId: trace.getSpanContext(parentContext)?.spanId,
            name: "agentguard.runtime.invoke",
            stage: "runtime",
            startedAt,
            startedAtMs,
            outcome,
            decision,
            toolCount,
          }),
          ...childSpans,
        ],
      };
      return finishedValue;
    },
  };
}

export function createApprovalConsumedTraceSpan(traceContext) {
  if (
    !/^[0-9a-f]{32}$/.test(traceContext?.traceId ?? "") ||
    !/^[0-9a-f]{16}$/.test(traceContext?.spanId ?? "")
  ) return null;
  const parentContext = trace.setSpanContext(context.active(), {
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
    traceFlags: Number(traceContext.traceFlags) & 1,
    isRemote: true,
  });
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const span = tracer.startSpan("agentguard.runtime.approval.consume", { kind: SpanKind.INTERNAL }, parentContext);
  return recordSpan({
    span,
    parentSpanId: traceContext.spanId,
    name: "agentguard.runtime.approval.consume",
    stage: "approval",
    startedAt,
    startedAtMs,
    outcome: "consumed",
  });
}
