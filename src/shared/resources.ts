export interface ResourceProcess {
  pid: number;
  type: string;
  labels: string[];
  residentMb: number;
  cpuPercent: number;
  wakeupsPerSecond: number;
}
export interface ResourceMetrics {
  processes: number;
  residentMb: number;
  cpuPercent: number;
  wakeupsPerSecond: number;
  sampledAt: number;
  details: ResourceProcess[];
}
