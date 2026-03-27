import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  ExtensionDataBackup,
} from "../../shared/data-backup";
import { sendMessage } from "./send-message";

export interface ImportBackupResult {
  importedAt: string;
  importedSkillIds: string[];
  removedSkillIds: string[];
}

export const useBackupStore = defineStore("backup-store", () => {
  const exporting = ref(false);
  const importing = ref(false);
  const error = ref("");

  async function exportBackup(): Promise<ExtensionDataBackup> {
    exporting.value = true;
    error.value = "";
    try {
      return await sendMessage<ExtensionDataBackup>("brain.storage.backup.export");
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      exporting.value = false;
    }
  }

  async function importBackup(
    backup: unknown,
  ): Promise<ImportBackupResult> {
    importing.value = true;
    error.value = "";
    try {
      return await sendMessage<ImportBackupResult>(
        "brain.storage.backup.import",
        { backup: backup as Record<string, unknown> },
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      importing.value = false;
    }
  }

  return {
    exporting,
    importing,
    error,
    exportBackup,
    importBackup,
  };
});
