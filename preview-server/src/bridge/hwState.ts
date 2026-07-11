export interface HardwareState {
  preset: string;
  cpuTemp: number;
  gpuTemp: number;
  battery: number;
  fanRpm: number;
  tdp: number;
  cpuClock: number;
  acPlugged: boolean;
  dock: boolean;
}

export const defaultHwState: HardwareState = {
  preset: "Idle",
  cpuTemp: 42,
  gpuTemp: 38,
  battery: 87,
  fanRpm: 1800,
  tdp: 8,
  cpuClock: 1400,
  acPlugged: true,
  dock: false,
};

export const presets: Record<string, Partial<HardwareState>> = {
  Idle: defaultHwState,
  "Hot Game": { cpuTemp: 85, gpuTemp: 78, battery: 32, fanRpm: 4200, tdp: 15, cpuClock: 2800, acPlugged: false },
  "Thermal Throttle": { cpuTemp: 95, gpuTemp: 88, battery: 20, fanRpm: 5800, tdp: 8, cpuClock: 1200, acPlugged: false },
  "Low Battery": { cpuTemp: 45, gpuTemp: 40, battery: 8, fanRpm: 1200, tdp: 5, cpuClock: 1200, acPlugged: false },
};
