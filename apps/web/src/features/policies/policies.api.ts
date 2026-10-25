import { request } from "../../shared/api/client";
import type { Overview } from "../../shared/types/api";

export async function updatePolicy(input: {
  id: string;
  name: string;
  maxAmount: number;
  maxAgeDays: number;
  currency: string;
}): Promise<Overview["policy"]> {
  return (
    await request(`/api/policies/${input.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).json().then((body) => body.policy);
}
