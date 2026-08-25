import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { armadaDmChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(armadaDmChannelPlugin);
