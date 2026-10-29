import { z } from "zod";

export const remediationCopilotSchema = z.object({
  summary: z.string().min(1).max(700),
  rootCause: z.string().min(1).max(700),
  fixPlan: z.array(z.object({
    title: z.string().min(1).max(120),
    rationale: z.string().min(1).max(320),
    implementation: z.string().min(1).max(900),
    verify: z.string().min(1).max(500),
  }).strict()).min(1).max(4),
  acceptanceCriteria: z.array(z.string().min(1).max(300)).min(1).max(5),
  caveats: z.array(z.string().min(1).max(300)).max(3),
}).strict();

export type RemediationCopilotPlan = z.infer<typeof remediationCopilotSchema>;
