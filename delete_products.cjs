 
const { initializeApp } = require("firebase/app");
const { getFirestore, collection, getDocs, deleteDoc, writeBatch, doc } = require("firebase/firestore");
const config = require("./firebase-applet-config.json");

const app = initializeApp(config);
const db = getFirestore(app);

async function deleteAll() {
  console.log("Fetching all products...");
  const snap = await getDocs(collection(db, "products"));
  console.log(`Found ${snap.size} products to delete...`);

  const batchSize = 500;
  let count = 0;
  let batch = writeBatch(db);

  for (const document of snap.docs) {
    batch.delete(doc(db, "products", document.id));
    count++;

    if (count % batchSize === 0) {
      await batch.commit();
      console.log(`Deleted ${count}/${snap.size}...`);
      batch = writeBatch(db);
    }
  }

  if (count % batchSize !== 0) {
    await batch.commit();
  }

  console.log(`Done! Deleted all ${count} products.`);
  process.exit(0);
}

deleteAll().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});