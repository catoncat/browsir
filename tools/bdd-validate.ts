import { loadContractCategories, runStructuralValidation, rel } from "./bdd-lib";

async function main() {
  const repoRoot = process.cwd();
  const snapshot = await runStructuralValidation(repoRoot);
  const errors = [...snapshot.errors];
  const categories = await loadContractCategories(repoRoot, errors);

  for (const loaded of snapshot.contracts) {
    if (!categories.categories.has(loaded.contract.id)) {
      errors.push(`contract ${loaded.contract.id} 缺少 category 映射 (bdd/mappings/contract-categories.json)`);
    }
  }

  for (const contractId of categories.categories.keys()) {
    if (!snapshot.contractsById.has(contractId)) {
      errors.push(`category 映射指向不存在的 contract: ${contractId}`);
    }
  }

  if (snapshot.warnings.length > 0) {
    console.log("[bdd:validate] warnings:");
    for (const warning of snapshot.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (errors.length > 0) {
    console.error("[bdd:validate] failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("[bdd:validate] ok");
  console.log(`  contracts: ${snapshot.contracts.length}`);
  console.log(`  features: ${Array.from(snapshot.featureRefs.values()).flat().length}`);
  console.log(`  categories: ${categories.categories.size} (${rel(repoRoot, categories.file)})`);
  console.log(`  mappings: ${snapshot.mappings.length} (${rel(repoRoot, snapshot.mappingFile)})`);
}

main().catch((err) => {
  console.error(`[bdd:validate] unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
