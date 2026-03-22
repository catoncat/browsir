import { ChannelStore } from "./channel-store";

export class ChannelSubsystem {
  readonly store: ChannelStore;

  constructor(store: ChannelStore = new ChannelStore()) {
    this.store = store;
  }
}
