import { decryptSecret } from "../../core/secrets.mjs";
import { deliverIncidentWebhook } from "./domain.mjs";
import * as repository from "../../infrastructure/repository.mjs";

let processing = false;

export async function processNextIncidentDelivery() {
  if (processing) return false;
  const delivery = await repository.claimNextIncidentDelivery();
  if (!delivery) return false;
  processing = true;
  try {
    await deliverIncidentWebhook({
      url: decryptSecret(delivery.encrypted_url),
      secret: decryptSecret(delivery.encrypted_secret),
      webhookId: delivery.webhook_id,
      notification: {
        id: delivery.notification_id,
        agentId: delivery.agent_id,
        agentName: delivery.agent_name,
        eventType: delivery.event_type,
        severity: delivery.severity,
        title: delivery.title,
        message: delivery.message,
        resourceType: delivery.resource_type,
        resourceId: delivery.resource_id,
        metadata: delivery.metadata ?? {},
        createdAt: delivery.created_at,
      },
    });
    await repository.completeIncidentDelivery({
      deliveryId: delivery.id,
      webhookId: delivery.webhook_id,
    });
    return true;
  } catch (error) {
    await repository.failIncidentDelivery({
      deliveryId: delivery.id,
      webhookId: delivery.webhook_id,
      attempts: delivery.attempts,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    processing = false;
  }
}

export function startIncidentWorker(intervalMs = 2000) {
  const timer = setInterval(() => {
    processNextIncidentDelivery().catch((error) =>
      console.error("Incident delivery worker error:", error),
    );
  }, intervalMs);
  timer.unref?.();
  processNextIncidentDelivery().catch((error) =>
    console.error("Initial incident delivery error:", error),
  );
  return timer;
}
