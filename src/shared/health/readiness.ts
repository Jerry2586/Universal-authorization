export type ComponentHealthStatus = 'up' | 'down';

export interface ComponentHealth {
  status: ComponentHealthStatus;
  latencyMs: number;
  message?: string;
}

export interface ReadinessReport {
  ready: boolean;
  components: Readonly<Record<string, ComponentHealth>>;
}

export type ReadinessCheck = () => Promise<ReadinessReport>;
