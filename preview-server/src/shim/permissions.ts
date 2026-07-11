/** Preview permission simulator state (defaults: all granted). */
const DEFAULT_PERMISSIONS: Record<string, boolean> = {
  hardware_control: true,
  filesystem: true,
  network: true,
  clipboard: true,
  audio: true,
  notifications: true,
};

let permissions: Record<string, boolean> = { ...DEFAULT_PERMISSIONS };

export function getPreviewPermissions(): Record<string, boolean> {
  return { ...permissions };
}

export function setPreviewPermissions(next: Record<string, boolean>): Record<string, boolean> {
  permissions = { ...permissions, ...next };
  if (typeof window !== "undefined") {
    (window as Window & { __deckyPreviewPermissions?: Record<string, boolean> }).__deckyPreviewPermissions =
      permissions;
  }
  return getPreviewPermissions();
}

export function isPreviewPermissionGranted(capability: string): boolean {
  if (permissions[capability] === false) return false;
  return permissions[capability] !== false;
}

export function resetPreviewPermissions(): void {
  permissions = { ...DEFAULT_PERMISSIONS };
}
