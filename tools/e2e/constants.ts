import path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dir, "..");
export const EXT_DIR = path.join(ROOT_DIR, "extension");
export const BRIDGE_DIR = path.join(ROOT_DIR, "bridge");
export const DEFAULT_EVIDENCE_PATH = path.join(ROOT_DIR, "bdd", "evidence", "brain-e2e.latest.json");
export const LIVE_EVIDENCE_PATH = path.join(ROOT_DIR, "bdd", "evidence", "brain-e2e-live.latest.json");

export const BRIDGE_HOST = "127.0.0.1";
export const TEST_TAB_TITLE = "BBL E2E";
