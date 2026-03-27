import type { PanelConfigNew } from "./panel-config";

export const EXTENSION_DATA_BACKUP_SCHEMA_VERSION = "bbl.extension-data.v1";

export interface ExtensionDataBackupSkill {
  id: string;
  name: string;
  description: string;
  location: string;
  source: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionDataBackupSkillFile {
  path: string;
  content: string;
}

export interface ExtensionDataBackupSkillPackage {
  skill: ExtensionDataBackupSkill;
  packageRoot: string;
  files: ExtensionDataBackupSkillFile[];
}

export interface ExtensionDataBackupPayload {
  config: PanelConfigNew;
  skills: ExtensionDataBackupSkillPackage[];
}

export interface ExtensionDataBackup {
  schemaVersion: typeof EXTENSION_DATA_BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  payload: ExtensionDataBackupPayload;
}
