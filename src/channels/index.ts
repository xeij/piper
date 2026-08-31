import { config } from "../config.js";
import { sendblueChannel } from "./sendblue.js";
import { twilioChannel } from "./twilio.js";
import type { Channel } from "./types.js";

export const channel: Channel =
  config.channel.provider === "sendblue" ? sendblueChannel : twilioChannel;

export type { Channel, InboundMessage, ChannelKind } from "./types.js";
