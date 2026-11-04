import Stripe from "stripe";
import { config } from "../config.js";
import type { User } from "../db/index.js";

let client: Stripe | undefined;
/** Lazy: an unset key must not crash startup. Stripe is optional until there is something to sell. */
export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  return (client ??= new Stripe(config.stripe.secretKey));
}

export async function checkoutUrl(
  user: User,
  plan: "monthly" | "yearly",
): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price:
          plan === "yearly" ? config.stripe.priceYearly : config.stripe.priceMonthly,
        quantity: 1,
      },
    ],
    customer: user.stripe_customer_id ?? undefined,
    client_reference_id: user.id,
    // No App Store, no 30% cut — one of the real structural advantages of
    // living in the messages app.
    success_url: `${config.publicBaseUrl}/subscribe/done`,
    cancel_url: `${config.publicBaseUrl}/subscribe/cancelled`,
    subscription_data: { metadata: { piper_user_id: user.id } },
    metadata: { piper_user_id: user.id },
    allow_promotion_codes: true,
  });
  return session.url!;
}
