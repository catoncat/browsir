import { runStructuralValidation, rel } from "./bdd-lib";

async function main() {
  const repoRoot = process.cwd();
  const snapshot = await runStructuralValidation(repoRoot);

  if (snapshot.warnings.length > 0) {
    console.log("[bdd:validate] warnings:");
    for (const warning of snapshot.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (snapshot.errors.length > 0) {
    console.error("[bdd:validate] failed:");
    for (const error of snapshot.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("[bdd:validate] ok");
  console.log(`  contracts: ${snapshot.contracts.length}`);
  console.log(`  features: ${Array.from(snapshot.featureRefs.values()).flat().length}`);
  console.log(`  mappings: ${snapshot.mappings.length} (${rel(repoRoot, snapshot.mappingFile)})`);
}

main().catch((err) => {
  console.error(`[bdd:validate] unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
