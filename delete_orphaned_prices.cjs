// delete_orphaned_prices.cjs
//
// One-time cleanup script: finds and deletes documents in the "prices"
// collection whose repId no longer matches any existing document in the
// "reps" collection. This cleans up price history left behind by the old
// handleDeleteRep() function, which deleted the rep profile but never
// touched its associated price entries.
//
// Run this ONCE after applying the RepDirectory.tsx fix that makes rep
// deletion cascade properly. After this cleanup, the fixed code will
// prevent new orphans from being created.
//
// Usage (same pattern as delete_products.cjs):
//   node delete_orphaned_prices.cjs
//
// Requires firebase-applet-config.json in the same directory (same as
// delete_products.cjs already expects).

const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs, deleteDoc, writeBatch, doc } = require("firebase/firestore");
const config = require("./firebase-applet-config.json");

const app = initializeApp(config);
const db = getFirestore(app);

async function deleteOrphanedPrices() {
  console.log("Fetching all reps...");
  const repsSnap = await getDocs(collection(db, "reps"));
  const validRepIds = new Set(repsSnap.docs.map(d => d.id));
  console.log(`Found ${validRepIds.size} existing reps.`);

  console.log("Fetching all price entries...");
  const pricesSnap = await getDocs(collection(db, "prices"));
  console.log(`Found ${pricesSnap.size} total price entries.`);

  const orphanedDocs = pricesSnap.docs.filter(d => {
    const repId = d.data().repId;
    return !repId || !validRepIds.has(repId);
  });

  console.log(`Found ${orphanedDocs.length} orphaned price entries to delete (repId no longer exists).`);

  if (orphanedDocs.length === 0) {
    console.log("Nothing to clean up. Done!");
    process.exit(0);
  }

  // Optional: print a quick preview before deleting, so you can sanity
  // check what's about to be removed.
  console.log("\nPreview of orphaned entries (first 10):");
  orphanedDocs.slice(0, 10).forEach(d => {
    const data = d.data();
    console.log(`  - priceId: ${d.id} | productId: ${data.productId} | repId: ${data.repId} | price: ${data.price}`);
  });

  const batchSize = 500;
  let count = 0;
  let batch = writeBatch(db);

  for (const document of orphanedDocs) {
    batch.delete(doc(db, "prices", document.id));
    count++;

    if (count % batchSize === 0) {
      await batch.commit();
      console.log(`Deleted ${count}/${orphanedDocs.length}...`);
      batch = writeBatch(db);
    }
  }

  if (count % batchSize !== 0) {
    await batch.commit();
  }

  console.log(`Done! Deleted ${count} orphaned price entries.`);
  process.exit(0);
}

deleteOrphanedPrices().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
