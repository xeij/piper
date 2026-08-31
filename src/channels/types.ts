export type ChannelKind = "imessage" | "sms";

export type InboundMessage = {
  from: string;          // E.164
  body: string;
  providerId: string;    // for idempotency
  kind: ChannelKind;
};

export interface Channel {
  readonly kind: ChannelKind;
  /** Does this transport render typing indicators? SMS does not. */
  readonly supportsTyping: boolean;
  send(to: string, body: string): Promise<{ providerId: string }>;
  sendTyping?(to: string): Promise<void>;
  /** Normalize a provider webhook payload into our shape, or null to ignore. */
  parseWebhook(payload: unknown): InboundMessage | null;
}
