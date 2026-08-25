export interface ArmadaTransportLifecycle {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export type ArmadaTransportFactory = () => ArmadaTransportLifecycle;
